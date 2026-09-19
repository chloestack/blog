---
title: "When Implementation Takes 5 Minutes, Where Does the Rest of the Developer's Time Go?"
date: "2026-09-14 14:05"
category: "AI"
tags: ["AI coding", "software engineering", "career", "weekly question"]
excerpt: "If coding is down to 5 minutes but alignment takes 4 days, what exactly fills the rest of a developer's day — and how do you make that visible?"
koSlug: "2026-09-14-구현이-5분이면-끝나는-시대-개발자의-나머지-시간은-어디에-쓰일까"
---

Sylwia Laskowska's post "[AI Is Already Better at Coding Than Most Software Developers](https://dev.to/sylwia-lask/ai-is-already-better-at-coding-than-most-software-developers-4hno)", published on DEV on September 10, made the monthly trending list. As of September 14: 175 reactions, 150 comments.

The title sounds like "developers are obsolete," but the actual argument is different. What the author is drawing a line between is **the speed of producing code** and **the value of software engineering**. This post takes that distinction as its starting point to answer this week's question.

> When implementation takes 5 minutes, where does the rest of the developer's time go?

## What the Original Post Does and Doesn't Say

The author's experience goes like this. A single change was needed in an application — the kind a coding agent could implement in 5 minutes. But **pinning down exactly what that change should look like**, coordinating with the teams involved, and reaching final agreement with the customer took 4 days. The decision changed multiple times during those 4 days. The author adds that an experienced developer absolutely had to be in those conversations.

The conclusion: 5 minutes to implement, 4 days to decide what to implement. That, the author says, is the difference between coding and software engineering.

That said, the title's claim — "AI is already better at coding than most developers" — is **the author's opinion**. The author cites research from METR and NBER, but those studies do not pit all developers against AI to rank them. They look at what AI agents can accomplish on specific tasks, and how AI tools change the pace of developer work. The author even notes that in earlier research, experienced developers using AI were actually slower, and that recent results are not as dramatic as coding benchmarks suggest. I covered that research in detail in [an earlier post](/posts/2026-09-10-ai-코딩-도구는-정말-시간을-줄여줄까).

So I think the accurate reading of this post is not "AI has beaten developers" but rather, as the original text puts it: "**the further you move from code generation, the less dramatic the machine's advantage becomes**." The author also adds the qualifier "at least for now."

## Where Did the 4 Days Go?

The post doesn't spell out what filled those 4 days. But any developer who's been through something similar can make a reasonable guess. Getting a single change agreed upon typically means answering questions like these:

- **What exactly needs to change?** Confirming whether what the requester described is actually what's needed.
- **How far does the impact reach?** Working out which APIs, batch jobs, and reports are affected if this field changes.
- **Who has to sign off?** Deciding which teams consuming the data, which ops teams, and which customers need to confirm.
- **What happens on failure?** Defining behavior when the process fails midway, needs to be rolled back, or mixes with old data.

None of these questions shrink just because the code gets written faster. This is precisely why an experienced developer needs to be in the room — someone who knows which requirements are cheap to implement and which are expensive, and where things tend to go wrong, is what keeps the discussion from drifting out of touch with reality.

One more thing I want to note: the part of the author's story where **the decision changed multiple times**. This is my inference, but when implementation gets cheap, reversing a decision can start to feel cheap too. Once "we can always rebuild it quickly" sets in, the pressure to close on an agreement weakens. If cheaper implementation leads to more time spent going back and forth on alignment, overall lead time may not shrink as much as expected.

## Five Places the Rest of the Time Goes

Here are five areas where I think developer time moves when implementation shrinks.

| Area | What AI reduces | What people still own |
| --- | --- | --- |
| Problem definition | Drafting requirements, generating question lists | Deciding what not to do, agreeing on failure conditions |
| Impact scope and alignment | Searching call graphs, listing changed files | Deciding whether to change cross-team contracts, finding decision-makers and getting sign-off |
| Verification | Drafting tests, automating repeated checks | Defining what needs to be verified for safety, explaining the results |
| Operations and rollback | Summarizing logs, writing deployment scripts | Setting deployment order and rollback criteria, catching silent failures |
| Decision records | Cleaning up meeting notes, drafting documentation | Leaving enough context to explain the rationale six months later |

### 1. Problem Definition: Narrowing Down to Failure Conditions

"Please add a partial refund feature to orders" is one line. But how to split an order with a coupon applied, which accounting period captures a refund after settlement closes, and what happens if the payment provider goes silent mid-refund — none of that is in the request.

Hand this request directly to an AI and you get plausible-looking code. The problem is that the code **quietly picks a side on every one of those questions**. Nobody knows who made those choices. This is where I think developer time should move first when implementation gets cheaper.

### 2. Impact Scope and Alignment: Contracts Outside the Code

For a change contained within a single service, AI is reasonably good at finding the impact scope. But if another team subscribes to an event schema, or a customer has built an integration that depends on a specific response format, it's a different story. Those contracts aren't fully written down in the repository. Knowing who is using something, and who needs to be told first when it changes, is something that requires organizational knowledge.

A good chunk of the author's 4 days probably went into exactly this coordination.

### 3. Verification: The Work That Gets More Expensive

When generation gets cheap, verification gets relatively more expensive. The author even noted with a laugh that a dropdown the agent built would open but not close. That kind of defect is at least obvious. The more dangerous code is the kind that works fine on the happy path but breaks under retries or concurrent requests.

How to distribute review when AI-generated PRs pile up is something I covered separately in [the review bottleneck post](/posts/2026-09-14-AI-코딩의-리뷰-병목은-어떻게-풀어야-할까). The core idea is to spend human time on **deciding in advance where to look deeply**, rather than reading every line.

### 4. Operations and Rollback: Days After a One-Line Fix

The [@Transactional rollback incident post](/posts/2026-09-14-로컬에선-롤백되는데-운영-WAS에선-안-되는-@Transactional) I wrote recently is a good example. The final fix was one line of YAML. An AI could have written that line in 5 minutes. But being able to say that line was correct took several days of building a diagnostic API, reproducing the issue on a dev WAS, and measuring with different options. Checking transaction propagation settings and lock contention that would kick in after the fix, and preparing an immediate rollback path, were all part of that same time.

Even if writing the code gets faster, **the time to confirm what a change actually does in production** doesn't go away.

### 5. Decision Records: Someone Who Can Explain It Later

When AI does the implementation and AI assists with the review, it becomes unclear who can answer the question "why was this built this way?" What you need six months later when an incident happens is not the code — it's the reasoning at the time. Capturing which alternatives were ruled out and which failure modes were accepted as a tradeoff is still the responsibility of the people who were part of the decision.

## Not Every Implementation Is 5 Minutes

Be careful about generalizing from the post's example. "5 minutes" is closer to a description of **a change that falls within a well-known pattern, after the question of what to build has already been settled**. In undocumented legacy systems, codebases where domain rules are scattered everywhere, or work where performance and concurrency are central concerns, the implementation itself still takes a long time.

And implementation getting faster doesn't mean implementation skill stops mattering. To recognize when AI-generated code looks wrong, you need to have understood the code well enough to write it yourself. Where junior developers develop that instinct is connected to the concern I raised in the [developer demand post](/posts/2026-09-10-ai와-개발자-수요).

## What a Team Can Actually Do

"A developer's value is in judgment" is true but vague as stated. Here are some concrete things to try.

- **Break lead time into pieces.** Track even just a handful of tasks: how long did pre-implementation alignment take, how long did implementation take, how long did it wait for review, how long did post-deployment verification take? The bottleneck is often not implementation. The 5 minutes and 4 days in the original post were only visible because they were measured separately.
- **Add a failure conditions field to your issues.** Alongside "what we're building," require "in these cases, it should behave like this" and "this is explicitly out of scope for now." This surfaces what humans need to decide before anything gets handed to AI.
- **Record why decisions changed.** Decisions changing multiple times isn't inherently bad. But if you don't capture why, you'll be having the same conversation again next month.
- **Set a clear standard for when to bring a developer into a meeting.** Developers don't need to be in every meeting. But when external contracts, data consistency, or hard-to-reverse changes are on the table, getting in the room from the start is what actually shortens those 4 days.

## Summary

Even if implementation shrinks to 5 minutes, a developer's day doesn't become 5 minutes long. The remaining time goes toward narrowing down what to build, deciding what needs to be agreed with whom, producing the evidence that a change is safe, and leaving enough behind to be able to explain it later.

The post's final sentence captures this shift well. AI getting better at coding doesn't reduce the value of software engineers — it means **coding's share of what engineering involves gets smaller**. I'd add one thing: until a team measures for itself where that freed-up time is actually going, nobody knows.
