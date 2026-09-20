---
title: "Java ClassLoader Hierarchy and Class Isolation"
date: "2026-09-21 02:38"
category: "Java"
tags: ["Java ClassLoader", "class isolation", "plugin system", "JVM internals", "URLClassLoader"]
excerpt: "A deep dive into Java ClassLoader hierarchy, delegation model, and how to implement class isolation for plugin systems and multi-version library coexistence."
koSlug: "2026-09-21-Java-ClassLoader-계층과-클래스-격리-구현"
---

## Table of Contents

1. Overview
2. Design Principles Behind the ClassLoader Hierarchy
3. How the Delegation Model Works
4. Implementing a Custom ClassLoader
5. Class Isolation Patterns In Depth
6. Performance and Trade-offs
7. Considerations for Production Environments
8. Closing Thoughts

---

## Overview

### Problem Background

Java ClassLoader is the heart of the mechanism by which the JVM brings class files into memory. There are situations where simply making an application "work" is not enough - you need to isolate different versions of the same library within a single JVM process, or load code dynamically at runtime. Plugin architectures, multi-tenant application servers, and deployment systems that require hot-swap are the canonical examples. Once you understand the Java ClassLoader hierarchy and know how to implement class isolation with a custom ClassLoader, you can solve these requirements directly at the JVM level. This post analyzes the ClassLoader hierarchy and delegation model in depth, then covers real isolation implementation patterns and things to watch out for in production.

> Understanding ClassLoaders means understanding how the JVM decides "is this class the same as that class?" That judgment criterion is the entirety of isolation design.

### Limitations of the Traditional Approach

In the traditional single-classpath model, a class with a given fully qualified class name (FQCN) is loaded exactly once. If you need library A v1.0 and v2.0 simultaneously and both versions share the same package and class names, you have to give one up. This is not just a dependency conflict - in large enterprise environments it leads to runtime errors, unpredictable behavior, and outages. OSGi has long been used to address this problem, and giving each module its own independent ClassLoader became the core of module isolation. The module system introduced in JDK 9 helps, but situations that require direct ClassLoader control are still common in practice.

| Scenario | Single classpath | Class isolation |
|---|---|---|
| Using two versions of the same library | Not possible | Each ClassLoader loads independently |
| Loading / unloading plugins at runtime | Not possible | Controlled by creating / releasing ClassLoaders |
| Separating classes per tenant | Risk of shared contamination | Guaranteed per-tenant isolation |
| Hot deployment | Full restart required | Only the target ClassLoader is replaced |

---

## Design Principles Behind the ClassLoader Hierarchy

### Roles of Bootstrap, Platform, and App ClassLoader

Java ClassLoaders are designed from the ground up to form a hierarchy. The JVM spec defines three built-in ClassLoaders and assigns each a clearly bounded responsibility.

**Bootstrap ClassLoader** is part of the JVM itself. It loads the core Java API classes such as `java.lang` and `java.util`. It is implemented in native (C/C++) code rather than Java, so calling `Class.getClassLoader()` on a class it loaded returns `null`. That is not a bug - it is a signal meaning "this class was loaded by the Bootstrap ClassLoader."

**Platform ClassLoader** (Extension ClassLoader before JDK 8) was responsible for extension classes under `$JAVA_HOME/lib/ext` or `java.ext.dirs`. After the module system was introduced in JDK 9 its name changed and its role was adjusted, but its position in the hierarchy remained.

**Application ClassLoader** (also called System ClassLoader) loads classes from the paths specified by `-classpath` or the `CLASSPATH` environment variable. Most application code we write is loaded through this ClassLoader. If you create a custom ClassLoader without explicitly specifying a parent, Application ClassLoader becomes the parent automatically.

```diagram
en/2026-09-21-56d0a588-01
```

The parent ClassLoader always attempts to load a class before the child does, protecting the integrity of the core API from being overridden by application code.

### Defining Class Identity

In Java, two classes being "the same" requires more than an identical FQCN. **The ClassLoader that loaded them must also be identical.** This definition is the core principle of class isolation. If ClassLoader A and ClassLoader B each load a class named `com.example.MyService`, the JVM treats them as different types.

This has an important consequence: you cannot directly cast objects loaded by different ClassLoaders. Attempting it throws `ClassCastException`, which is the root cause of what is commonly called a "ClassLoader conflict." Communication between isolated ClassLoaders must therefore always go through an interface or abstract class loaded by a common ancestor ClassLoader.

| Condition | Same class? | Result |
|---|---|---|
| Same FQCN + same ClassLoader | ✓ Same | Cast succeeds |
| Same FQCN + different ClassLoader | ✗ Different | ClassCastException |
| Different FQCN + same ClassLoader | ✗ Different | Obviously different |
| Interface loaded by ancestor CL | ✓ Shared | Safe isolation boundary |

### Namespaces and Class Visibility

Each ClassLoader defines its own **namespace**. A child ClassLoader can see its parent's namespace, but the parent cannot see the child's. This one-way visibility is an intentional design choice.

The fact that a parent cannot see its children can cause problems with service locator or factory method patterns. When an implementation must be found dynamically - as with `javax.xml.parsers.DocumentBuilderFactory` - code loaded by the Bootstrap ClassLoader may fail to find an implementation sitting in the Application ClassLoader. The Thread Context ClassLoader concept was introduced to solve this. SPI mechanisms such as JDBC driver loading make heavy use of it. Without knowing the visibility rules, it is hard to understand why that SPI pattern works at all.

> A parent cannot see its children. If sharing is required, the class must live in a common ancestor ClassLoader. This is the first principle of isolation design.

---

## How the Delegation Model Works

### The Parent-First Delegation Flow

When a ClassLoader receives a class loading request, it does not immediately search its own scope. It first delegates the request to its parent ClassLoader and only searches for the class itself if the parent fails. This "parent-first delegation" has been the core mechanism since Java 1.2.

The most important effect of parent-first delegation is **core API protection**. Even if someone creates a class designed to maliciously replace `java.lang.String`, the Bootstrap ClassLoader always handles it first, making replacement impossible. Additionally, a given class is loaded only once within the JVM, saving memory and guaranteeing type consistency. Conversely, when implementing class isolation you sometimes need to invert this delegation order - that is covered in the next section.

```diagram
en/2026-09-21-56d0a588-02
```

The ClassLoader only searches its own scope if the parent fails, and if everything fails a `ClassNotFoundException` propagates back to the caller.

### loadClass vs findClass

When subclassing `ClassLoader`, deciding whether to override `loadClass()` or `findClass()` requires a precise understanding of the design intent. `loadClass()` is the entry point that controls the entire delegation model. Overriding it lets you change the parent delegation behavior itself. `findClass()`, by contrast, handles only "how do I find the class once the parent has failed?"

The official Sun Microsystems recommendation for the general case is to override only `findClass()`. Overriding `loadClass()` can break parent delegation and lose the core API protection described above. When you intentionally implement class isolation - that is, when you need child-first behavior where the child looks first and the parent is a fallback - you must override `loadClass()` carefully. Failing to understand the distinct roles of these two methods is a common source of subtle bugs.

| Method | Role | Effect when overridden | Recommended? |
|---|---|---|---|
| `loadClass()` | Controls the full delegation flow | Can change parent delegation strategy | Only when implementing isolation |
| `findClass()` | Searches for the actual bytecode | Changes only where / how to search | Recommended for the general case |
| `defineClass()` | Converts bytecode to a Class object | Allows bytecode transformation at load time | Almost never overridden |
| `resolveClass()` | Resolves symbolic references | Controls when references are resolved | Almost never overridden |

### The Role of the Thread Context ClassLoader

Java SPI (Service Provider Interface) is a representative pattern for separating code from implementation. `ServiceLoader`, JDBC, JNDI, and others use it. But how can `ServiceLoader`, loaded by the Bootstrap ClassLoader, discover an implementation that lives in the Application ClassLoader? The answer is the **Thread Context ClassLoader**. Accessed via `Thread.currentThread().getContextClassLoader()`, this ClassLoader can be set per thread and is used when code in an upper ClassLoader needs to dynamically find classes from a lower one.

Web application servers (Tomcat, JBoss, etc.) set the Thread Context ClassLoader to the ClassLoader of the currently deployed web app on each request, achieving class isolation between web apps. In a multi-threaded environment where a specific thread needs to operate under a different ClassLoader context, the pattern of swapping the context ClassLoader before the work and restoring it afterward is mandatory. Forgetting to restore it means threads reused from a thread pool will keep running under the wrong ClassLoader context.

> Thread Context ClassLoader is the legitimate bypass for the hierarchy constraint "a parent cannot see its children." The entire SPI mechanism stands on this bypass.

---

## Implementing a Custom ClassLoader

### Basic Isolation with URLClassLoader

Java ships with a well-tested implementation called `URLClassLoader`. Pass an array of URLs pointing to JAR files or directories and you have a ClassLoader that loads from those paths immediately. When plugins are packaged as external JARs and need to be loaded dynamically at runtime, this is the simplest approach. The key is to ensure that common interfaces are always loaded by the parent ClassLoader, so that the plugin ClassLoader and the host code share the same type definitions. The example below shows the pattern for loading a plugin implementation from an external JAR and calling it safely through a common interface.

```java
// Plugin.java - common interface (loaded by App ClassLoader)
public interface Plugin {
    String execute(String input);
}

// PluginLoader.java - URLClassLoader-based plugin loader
public class PluginLoader implements AutoCloseable {

    private final URLClassLoader classLoader;

    public PluginLoader(Path jarPath) throws MalformedURLException {
        // Set the parent to the current Thread Context CL so the Plugin interface is shared
        this.classLoader = new URLClassLoader(
            new URL[]{jarPath.toUri().toURL()},
            Thread.currentThread().getContextClassLoader()
        );
    }

    public Plugin load(String className) throws Exception {
        // Load the class with the plugin JAR's ClassLoader, then cast to Plugin
        Class<?> clazz = classLoader.loadClass(className);
        return (Plugin) clazz.getDeclaredConstructor().newInstance();
        // Result: callable in a type-safe way through the Plugin interface
    }

    @Override
    public void close() throws IOException {
        classLoader.close(); // Explicit release prevents Metaspace leaks
    }
}
```

Because the `Plugin` interface is loaded by the parent ClassLoader (Application CL), both the plugin JAR's ClassLoader and the main code share the same `Plugin` type. Implementing `AutoCloseable` is not a formality - closing the ClassLoader is required for the class metadata it loaded to become eligible for GC.

### Implementing a Child-First ClassLoader from Scratch

Beyond simple isolation, if you need to use two different versions of the same class name simultaneously you must invert the parent-first delegation. Tomcat does exactly this for each web app. Override `loadClass()`, but you must unconditionally delegate `java.*` and `javax.*` packages to the parent. Skipping that step causes the loader to attempt to reload classes like `java.lang.Object`, which either throws a `SecurityException` or produces the abnormal state of two `Object` types coexisting in the same JVM.

```java
public class ChildFirstClassLoader extends URLClassLoader {

    public ChildFirstClassLoader(URL[] urls, ClassLoader parent) {
        super(urls, parent);
    }

    @Override
    protected Class<?> loadClass(String name, boolean resolve)
            throws ClassNotFoundException {

        synchronized (getClassLoadingLock(name)) {
            // 1. Reuse already-loaded classes
            Class<?> loaded = findLoadedClass(name);
            if (loaded != null) return loaded;

            // 2. java.* / javax.* must always delegate to the parent (core API protection)
            if (name.startsWith("java.") || name.startsWith("javax.")) {
                return super.loadClass(name, resolve);
            }

            // 3. Search self first (Child-First)
            try {
                Class<?> clazz = findClass(name);
                if (resolve) resolveClass(clazz);
                return clazz;
            } catch (ClassNotFoundException e) {
                // 4. Fall back to parent if not found locally
                return super.loadClass(name, resolve);
            }
        }
    }
}
```

The synchronization on `getClassLoadingLock()` supports parallel class loading (available since JDK 7). It prevents duplicate loading when two threads try to load the same class simultaneously.

### defineClass and Bytecode Transformation

`defineClass()` converts a byte array into a `Class` object. Manipulating the bytecode at this stage lets you implement AOP, instrumentation, and per-version feature patching at the ClassLoader level. Java Agents and libraries such as ASM and Byte Buddy use this principle internally. That said, injecting malformed bytecode at this stage results in a `VerifyError` and loading fails outright.

```diagram
en/2026-09-21-56d0a588-03
```

Inserting a bytecode transformation step inside `defineClass()` lets you inject AOP or instrumentation code at the ClassLoader level - this is the technical foundation of Java Agents.

---

## Class Isolation Patterns In Depth

### Plugin Architecture Design

The most important design decision when applying class isolation in a real plugin system is **where to draw the boundary between shared and isolated classes**. Share too much and isolation disappears; share too little and communication between the plugin and the host becomes impossible. The commonly adopted pattern is **API layer separation**: the interfaces that plugins must implement and value objects (VO/DTO) are placed in a separate module, and only that module is loaded by the parent ClassLoader. Plugin implementations and any third-party libraries the plugin depends on all live within the isolated ClassLoader scope of that plugin.

This way, plugin A can use `jackson-databind:2.14` and plugin B can use `jackson-databind:2.15` without conflict. Even though both versions share the same FQCN, each is loaded by a different ClassLoader, so the JVM treats them as different types.

```diagram
en/2026-09-21-56d0a588-04
```

The App ClassLoader owns the shared API; each plugin runs under its own isolated ClassLoader with its own version of each library.

### Strategies for Deciding Isolation Scope

Three strategies are worth considering when deciding how wide to make class isolation. The first is **per-JAR isolation**, which assigns a separate ClassLoader to each JAR file. This is the finest-grained isolation, but the number of ClassLoaders explodes and the management overhead and memory cost grow accordingly. The second is **per-plugin isolation**, which creates one ClassLoader per plugin (functional unit) and includes all of that plugin's dependencies inside it. This is the most widely used, well-balanced approach. The third is **version-group isolation**, where plugins that use the same version of a library share a ClassLoader. Memory efficiency is high, but upgrading one version affects everything in the shared group. The right strategy depends on how many plugins you have, how often dependency conflicts arise, and what your memory budget is.

| Strategy | Number of ClassLoaders | Memory efficiency | Isolation strength | When to use |
|---|---|---|---|---|
| Per-JAR | Many | Low | Maximum | Environments where security is the top priority |
| Per-plugin | Medium | Medium | Strong | General-purpose plugin systems |
| Version-group | Few | High | Medium | Many plugins with infrequent conflicts |

### Serialization and Isolated Classes

Using Java serialization in a class-isolated environment can produce unexpected problems. When deserializing an object, the JVM needs to find the corresponding class, but classes belonging to an isolated ClassLoader are invisible along the default deserialization path. Solving this requires subclassing `ObjectInputStream` and overriding `resolveClass()` to reference the correct ClassLoader. This is tedious to implement and prone to errors.

A more practical solution is to switch serialization frameworks. ClassLoader-agnostic serialization formats - JSON (Jackson, Gson), Protocol Buffers, MessagePack - are far safer for transmitting data across isolation boundaries. In this model, cross-boundary communication becomes pure data transfer, and type information is exchanged only through interfaces in the shared API layer. It is worth establishing from the start of isolation design that Java serialization will not be used for cross-boundary communication.

> Communication across an isolation boundary should deal only in "data"; "types" are exchanged only through the shared API layer. This single principle prevents most ClassCastExceptions.

---

## Performance and Trade-offs

### ClassLoader Impact on Memory

Creating ClassLoaders without discipline can lead to **Metaspace exhaustion**. Before JDK 8, PermGen played this role and was responsible for countless `OutOfMemoryError: PermGen space` incidents. Since JDK 8 Metaspace expands dynamically by default, but it does not grow without limit - set `-XX:MaxMetaspaceSize` and the same problem recurs. The metadata for every class a ClassLoader loads (method tables, constant pools, bytecode, etc.) lives in Metaspace. If a ClassLoader instance is not GC'd, the classes it loaded are not released from Metaspace either.

```diagram
en/2026-09-21-56d0a588-05
```

A strong reference to a ClassLoader prevents GC, keeping the class metadata it loaded alive in Metaspace and turning it into a leak.

### Class Loading Cost and Caching

Class loading is far from cheap. The full sequence - JAR file scanning, bytecode reading, Verification, Preparation, Resolution, and Initialization - can take tens of milliseconds. In a large plugin system where plugins are frequently unloaded and reloaded, the accumulated cost can noticeably affect application response time.

`findLoadedClass()` lets you skip reloading an already-loaded class. Because a ClassLoader maintains an internal cache, requesting the same class multiple times from the same ClassLoader instance goes through the full loading process only once. This characteristic lets you design a system where frequently used classes are owned by a long-lived ClassLoader while single-use classes are handled by a separate ClassLoader and released immediately, pursuing both performance and isolation.

| Class loading phase | Main work | Cost |
|---|---|---|
| Loading | JAR scan, bytecode read | I/O cost |
| Verification | Bytecode validity check | CPU-intensive |
| Preparation | Static field memory allocation | Memory allocation |
| Resolution | Symbolic references → direct references | Lazy or eager |
| Initialization | Static initializer execution | Code execution cost |

### OSGi, Jigsaw, and URLClassLoader Compared

There are multiple ways to achieve class isolation beyond a custom ClassLoader. OSGi gives each bundle its own ClassLoader and manages package sharing through Export/Import declarations. Very fine-grained isolation is possible, but the learning curve and runtime complexity are high. JDK 9's module system (Jigsaw) strengthens compile-time isolation, but its runtime isolation is not as flexible as OSGi or a custom ClassLoader. `URLClassLoader` is the simplest to configure, ships with the JDK, and is suitable when you need an implementation quickly rather than fine-grained control. All three involve trade-offs, so choose based on how complex your requirements are.

| Approach | Runtime isolation | Version conflict resolution | Configuration complexity | When to use |
|---|---|---|---|---|
| URLClassLoader | Strong | Possible | Low | Fast implementation, simple isolation |
| Custom ClassLoader | Maximum | Full control | High | When fine-grained isolation is required |
| OSGi | Strong | Export/Import | Very high | Large-scale module systems |
| Jigsaw modules | Medium | Limited | Medium | When compile-time boundaries are sufficient |

---

## Considerations for Production Environments

### Common Mistakes and Pitfalls

The most frequent ClassLoader-related problem is **ClassLoader leaks**. Every time a web application is redeployed in an application server, a new ClassLoader is created. If a reference to the previous ClassLoader survives somewhere, GC cannot collect it and Metaspace shrinks bit by bit. The main paths through which old ClassLoader references are held implicitly are: objects stored in `ThreadLocal`, instances cached in static fields, and `Runnable` or `Callable` tasks running in a thread pool. The second common pitfall is **logging framework conflicts**. Logging libraries like SLF4J work by ClassLoader binding, so if a plugin has its own isolated ClassLoader but does not share the logging configuration, log output may be missing or configuration may be applied twice. The fix is to place the logging API (SLF4J API) in the shared ClassLoader and load the implementation (Logback) only from the host application's ClassLoader.

```diagram
en/2026-09-21-56d0a588-06
```

Stale ClassLoader references left in thread pools and static fields are the main entry points for Metaspace leaks.

### Monitoring and Debugging

The first tool for diagnosing ClassLoader problems in production is JVM flags. `-verbose:class` or `-Xlog:class+load=info` prints which ClassLoader loaded each class, which is useful for tracing class conflicts or unexpected loading paths.

**Monitoring Metaspace usage** is the key metric for catching ClassLoader leaks early. Regularly collecting `Usage.used` from `java.lang:type=MemoryPool,name=Metaspace` via JMX lets you detect the pattern of Metaspace not decreasing after a redeployment. If Metaspace grows incrementally with each successive redeployment, a ClassLoader leak is the strong suspect.

| Diagnostic tool | What it reveals | Best for |
|---|---|---|
| `-verbose:class` | Which ClassLoader loaded each class | Tracing unexpected loading paths |
| JMX Metaspace metrics | Metaspace usage trend | Early leak detection |
| Eclipse MAT (heap dump) | Memory retained per ClassLoader | Pinpointing the leaking ClassLoader |
| `Class.getClassLoader()` | Which loader owns a specific class | Diagnosing ClassCastException root cause |

Heap dump analysis is also important. Eclipse Memory Analyzer (MAT)'s "ClassLoader Explorer" feature lets you visually inspect how many classes each ClassLoader has loaded and how much memory it retains. Sorting by "retain heap" immediately shows which ClassLoader is holding on to an excessive amount of memory.

### Scaling and Migration

When migrating an existing single-ClassLoader structure to a multi-ClassLoader architecture, incremental transition is critical. Trying to isolate all components at once produces a flood of `ClassCastException` and `NoClassDefFoundError` problems simultaneously, making debugging extremely difficult. Instead: isolate the most independent components first, define the interface contract at the isolation boundary clearly, then migrate the rest sequentially.

There are also subtle behavioral differences in ClassLoader behavior across JDK versions. After JDK 9, `URLClassLoader.close()` behaves more strictly, and referencing the Bootstrap ClassLoader returns the Platform ClassLoader reference rather than `null` in some places - both can cause unexpected behavior during migration. This is exactly why ClassLoader-related code must be thoroughly reviewed when upgrading to JDK 17 or JDK 21.

```diagram
en/2026-09-21-56d0a588-07
```

Incremental migration cycles through: identify independent components → apply isolation → validate the interface. Attempting to change everything at once causes unexpected conflicts.

---

## Closing Thoughts

### Key Takeaways

Java ClassLoader is more than a class loading utility - it is core infrastructure responsible for isolation and dynamic extensibility of the JVM runtime. The Bootstrap → Platform → Application hierarchy and the parent-first delegation model protect the integrity of the core API while leaving room for custom ClassLoaders to intervene. `URLClassLoader` is the practical choice for fast implementation; a Child-First ClassLoader that overrides `loadClass()` addresses more sophisticated requirements involving library version isolation. Communication between isolated ClassLoaders must go exclusively through interfaces loaded by a shared ancestor ClassLoader to guarantee type safety. Managing Metaspace and ClassLoader references correctly is a prerequisite for operating this structure reliably in production.

> The essence of class isolation is "treating classes with the same name as different types." That single sentence drives every decision in the design.

### Deciding When to Apply This

You can use the following criteria to judge whether a custom ClassLoader and class isolation are actually needed. First, **do you need to use different versions of the same library simultaneously in the same JVM?** If simple dependency resolution cannot solve it, ClassLoader isolation is the only practical answer. Second, **do you need to dynamically load and unload code at runtime?** Plugin systems, hot deployment, and multi-tenant environments fall here. Third, **do you need to run untrusted code in isolation?** ClassLoader isolation can limit the blast radius on the host application. On the other hand, if your goal is simple dependency separation or build-time modularization, Jigsaw modules or build-tool-level solutions are more appropriate. Direct ClassLoader control is powerful, but it brings complexity - Metaspace management, `ClassCastException` risks, and leak hazards. Before adopting it, first verify that your requirements are clear enough to justify that complexity.

| Scenario | Recommended approach |
|---|---|
| Need to run multiple library versions concurrently | Child-First ClassLoader or URLClassLoader |
| Runtime plugin load / unload | URLClassLoader + AutoCloseable pattern |
| Building a large-scale module system | OSGi or custom ClassLoader |
| Strengthening compile-time boundaries | Jigsaw modules |
| Simple dependency separation | Build tool (Maven / Gradle) level is sufficient |
