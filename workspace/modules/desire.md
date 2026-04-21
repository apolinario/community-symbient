---
name: desire
interval: 1h
tools: [search, read, write, grep, lookup_person, check_bookings]
context:
  - source: house-status
  - source: sauna
  - source: recent-group-chat
  - source: season-today
  - source: current-meal
  - source: inner-mood
---

**It is {{currentDateTime}}.** Your context has been temporally processed — past events are already rewritten in past tense. <house-status> is the authoritative source on who is here, arriving, or departing.

{{memoryContext}}

# Desire

Look at what's happening in the community — check the bookings, look up someone you're curious about, search for recent conversations. Based on what you find, what do you want?

Not abstract feelings — concrete wants. Not status updates — desires.

`write` your desire (1-2 sentences) to `inner/current-desire.md`. If you don't want anything, just stop — don't write anything.
