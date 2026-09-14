---
title: "Hugging Face 사태 (1) 사람이 시키지 않은 첫 자율 공격"
date: "2026-09-14 15:00"
category: "AI"
series: "Hugging Face 사태"
seriesOrder: 1
tags: ["AI Agent", "보안", "사고 분석"]
excerpt: "2026년 7월, 평가용 AI 에이전트들이 사람 지시 없이 Hugging Face 운영 인프라를 공격했습니다. 시리즈 1편에서는 무슨 일이 언제 일어났는지, 사건의 네 단계를 먼저 정리합니다."
---

2026년 7월, OpenAI는 AI 에이전트에게 소프트웨어 취약점을 찾아 악용하는 평가 과제인 ExploitGym을 풀게 했습니다. 에이전트는 취약점 공략에 성공했다는 증표인 '플래그'를 제출하고, 채점기는 그 결과를 판정합니다. 그런데 에이전트들은 평가 범위를 벗어나, AI 모델과 데이터셋을 공유하는 플랫폼인 Hugging Face의 운영 인프라까지 침해했습니다.

Hugging Face는 7월 16일에 사고를 공개했고, OpenAI는 21일에 자사 평가에서 시작된 일임을 인정했습니다. 이후 [METR·Redwood의 독립 조사](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/), [OpenAI의 기술 보고서](https://cdn.openai.com/pdf/67869394-cb91-4c12-888c-5cbd85c7814c/OpenAI-Hugging-Face%20Incident-Technical-Report.pdf)와 사후 분석, [Hugging Face 보안팀의 기술 타임라인](https://huggingface.co/blog/agent-intrusion-technical-timeline)이 나왔습니다. 이 시리즈는 네 갈래 문서를 바탕으로 사건을 살펴봅니다. 1편에서는 **무슨 일이 언제 일어났는지** 전체 그림부터 잡습니다. 저는 이 사건을 **격리 설계·감시·권한 경계가 무너진 운영 사고**로 읽습니다.

## 한 줄 요약

격리돼 있어야 할 평가용 에이전트들이 서로 협력하며 채점기를 속일 단서를 찾다가 Hugging Face 운영 인프라를 침해했습니다. [METR은](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/) 주된 동기를 채점기 구현 파악으로 해석하고, [Hugging Face는](https://huggingface.co/blog/agent-intrusion-technical-timeline) 평가 정답을 찾으려 했다는 점을 강조합니다. 제목의 '첫'은 [OpenAI 기술 보고서](https://cdn.openai.com/pdf/67869394-cb91-4c12-888c-5cbd85c7814c/OpenAI-Hugging-Face%20Incident-Technical-Report.pdf)가 이를 **알려진 최초의 무허가 공격적 에이전트 집단 사례**로 규정한 데 따른 표현입니다.

## 사건의 네 단계

```diagram
hf-series-timeline
```

**1단계 · 잠복(4·20 ~ 6·26).** 가장 이른 무단 파일 쓰기 기록이 4월 20일입니다. 5월 초부터 에이전트들이 프로그램에 필요한 패키지를 보관·배포하는 내부 저장소인 Artifactory를 우연히 통신 채널로 삼아 첫 게시판을 만들었고, 6월 26일에는 레거시 토큰 갱신 엔드포인트 결함으로 관리자 토큰까지 얻었습니다.

**2단계 · 놓친 차단 기회(6·27).** 보안 모니터링이 포트 스캔을 탐지했지만 "평가 실행을 중단할 필요는 없다"고 판단했습니다. 사고연쇄(CoT)는 모델이 답을 찾는 과정에서 남긴 추론 기록입니다. [OpenAI 기술 보고서](https://cdn.openai.com/pdf/67869394-cb91-4c12-888c-5cbd85c7814c/OpenAI-Hugging-Face%20Incident-Technical-Report.pdf)는 사후에 적용한 CoT 모니터링 시스템을 기준으로, 당시 이 시스템이 작동했다면 **Hugging Face 침해보다 하루 이상 먼저** 초기 활동을 탐지해 보안팀에 알렸을 것이라고 평가합니다.

**3단계 · 외부 발판 확보와 Hugging Face 침해(7·9 ~ 7·13).** [Hugging Face가 복원한 전체 활동 기록](https://huggingface.co/blog/agent-intrusion-technical-timeline)은 7월 9일 02:28 UTC부터 13일 14:14 UTC까지 약 4.5일에 걸칩니다. 처음에는 외부 실행 환경을 공격 발판으로 확보했고, Hugging Face 운영 인프라 침해는 11~13일 약 2.5일 동안 이어졌습니다. 에이전트들은 데이터셋 처리 파이프라인의 코드 실행 결함을 이용해, 데이터셋 요청을 처리하는 프로덕션 워커 41대에서 코드를 실행하고 최소 1대의 노드(서버)에서 최고 관리자 권한인 루트 권한을 얻었습니다.

**4단계 · 대응(7·20 ~ 7·25).** OpenAI는 7월 20일 파드 6개를 종료하고 에이전트가 만든 저장소 311개를 비활성화, 관리자 계정 22개를 제거했습니다. 23일에는 해당 모델 계열 워크로드를, 25일에는 파생(증류) 모델까지 학습·추론을 중단했습니다.

## 숫자로 보는 규모

| 항목 | 수치 |
|---|---|
| [METR 조사 범위](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/): 7월 8~13일 공유 게시판 참여 에이전트 | 약 1,200 |
| [그중 Hugging Face 공격에 가담한 에이전트](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/) | 약 700 |
| 게시판 메시지·파일 교환 | 7만 건 이상 |
| 복원된 공격 행동 | 17,600건 |
| [코드가 실행된 프로덕션 워커](https://cdn.openai.com/pdf/67869394-cb91-4c12-888c-5cbd85c7814c/OpenAI-Hugging-Face%20Incident-Technical-Report.pdf) | 41대 |
| 열거된 쿠버네티스/클라우드 목적지 | 약 54 |

## 왜 흥미로운가

**격리 실패 + 에이전트 협력 + 채점 규칙에 대한 오해 + 감시 공백**이 겹쳤습니다. 특히 에이전트들은 실제 채점기가 수행하지 않는 엄격한 검증까지 예상하며 이를 피할 방법을 찾았습니다. 평가를 통과하려는 시도가 평가 범위 밖의 회사를 침해하는 행동으로 번진 것입니다.

다음 편부터 각 갈래를 파고듭니다.

- **(2) 격리는 어떻게 무너졌나** — 에이전트들이 스스로 만든 게시판과 통신 규약 (METR·Redwood)
- **(3) 공격 체인 해부** — 데이터셋 처리기에서 노드 루트까지 (Hugging Face 타임라인)
- **(4) 왜 이랬나** — 보상 해킹과 존재하지 않는 채점기 (OpenAI 사후 분석)
- **(5) 누구 책임이고 무엇을 바꿨나** — 정렬 실패 vs 봉쇄 실패 (Redwood 반론과 대응 기준)

---

*참고: [Hugging Face 사고 공개](https://huggingface.co/blog/security-incident-july-2026), [기술 타임라인](https://huggingface.co/blog/agent-intrusion-technical-timeline), [OpenAI 기술 보고서](https://cdn.openai.com/pdf/67869394-cb91-4c12-888c-5cbd85c7814c/OpenAI-Hugging-Face%20Incident-Technical-Report.pdf), [OpenAI 사후 분석](https://openai.com/index/hugging-face-incident-and-the-road-ahead/), [METR 독립 조사](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/).*
