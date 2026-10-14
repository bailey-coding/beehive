---
category: architecture
status: active
audience: human,agent
tags:
  - core
  - design
---


## ✅ Implementation Checklist

Before implementing any feature, ensure you understand:

- [ ] How the Spec DO stores and retrieves state
- [ ] Which worker handles which responsibility
- [ ] How workers communicate (bindings vs HTTP)
- [ ] The authentication model (fail-closed)
- [ ] The data flow for your feature
- [ ] Where to store new data (Spec DO? D1? Analytics Engine?)

> **Do not begin implementation before understanding this document and AGENTS.md.**
