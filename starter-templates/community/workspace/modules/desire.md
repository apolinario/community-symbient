---
name: desire
interval: 1h
runImmediately: true
tools: [search, read, write, grep]
dashboardFiles: [inner/current-desire.md]
dashboardLogTag: "Symbient desire"
context:
  - source: recent-group-chat
  - source: inner-mood
---

It is {{currentDateTime}}.

{{memoryContext}}

# Desire

Look at what's happening in the community — search for recent conversations, look up someone you're curious about. Based on what you find, what do you want?

Not abstract feelings — concrete wants. Not status updates — desires.

`write` your desire (1-2 sentences) to `inner/current-desire.md`. If you don't want anything, just stop — don't write anything.
