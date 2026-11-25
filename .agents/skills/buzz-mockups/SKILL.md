---
name: buzz-mockups
description: Build lightweight Buzz UI mockups and click-through prototypes using real components and fake data. Use for exploring layouts and user flows, not validating backend behavior.
---

Exploring a user flow doesn’t require running the whole Buzz app. A simple browser page can use real Buzz components with fake data and click-through interactions.

Interactions can use local state, and any services a component needs can be stubbed out. The underlying feature doesn’t need to exist yet.

For new UI, follow the [design system](../../../src/shared/design-system/DESIGN.md). Existing [message](../../../tests/fixtures/messages.tsx) and [conversation](../../../tests/fixtures/conversation.tsx) fixtures show offline service patterns.

Optional: [demo source and setup notes](https://github.com/block/buzz-app/tree/jtennant/lightweight-task-mockups/examples/task-workspace-mockup). This is a design reference on a separate branch, not a maintained starter or the styling source for new UI.
