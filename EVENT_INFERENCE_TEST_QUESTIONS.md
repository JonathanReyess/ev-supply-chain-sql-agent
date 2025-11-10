# Event Inference & Analysis Test Questions

## Reassignment Events

### Priority Changes
1. Why was door FCX-D02 reassigned?
2. What caused the reassignment of door FCX-D10?
3. Tell me about the priority change at door FCX-D11
4. What was the reason for changing door assignments at Fremont CA?
5. Explain why dock door 2 was reassigned
6. What happened with the door reassignment at Shanghai?

### ETA Slips
7. Why was door FCX-D12 reassigned?
8. What caused the ETA slip at door FCX-D01?
9. Tell me about truck delays affecting dock assignments
10. Which doors were reassigned due to ETA changes?
11. What was the delay for door FCX-D12?
12. Explain the reassignment at dock 12

### Operational Conflicts
13. What operational conflicts occurred at door FCX-D02?
14. Why did we have to reassign door FCX-D01?
15. Tell me about conflicting assignments at Fremont
16. What caused the operational conflict at Berlin doors?
17. Explain door conflicts at Shanghai
18. How many reassignments were due to operational conflicts?

## ETA Update Events

### Truck Delays
19. Which trucks had ETA updates today?
20. What was the delay for truck T-FCX-179?
21. Tell me about ETA changes for Fremont inbound trucks
22. How much was truck T-FCX-402 delayed?
23. What caused the ETA update for truck T-FCX-617?
24. List all ETA slips in the last hour
25. Show me trucks with significant delays

### ETA Impact
26. How did the ETA slip affect door assignments?
27. Which doors were impacted by truck T-FCX-179 delay?
28. Tell me about reassignments caused by late trucks
29. What happened when truck T-FCX-402 was delayed?
30. Explain the impact of ETA updates on the schedule

## Assignment Status Events

### Completed Events
31. Which assignments were completed today?
32. Tell me about completed dock operations at door FCX-D04
33. What assignments finished at Fremont CA?
34. Show me completion events for truck T-FCX-617
35. How long did assignment ASG-FCX-59600 take?
36. List all completed inbound operations

### Status Changes
37. What is the current status of assignment ASG-FCX-71695?
38. Tell me about status changes at door FCX-D10
39. Which assignments are in progress at Shanghai?
40. Show me cancelled assignments
41. What assignments changed status today?
42. Explain the status history for door FCX-D02

## Temporal & Pattern Questions

### Event Sequences
43. What happened at door FCX-D10 today?
44. Show me the event timeline for door FCX-D02
45. What events occurred at Fremont CA in the last hour?
46. Give me the sequence of events for truck T-FCX-617
47. What was the history of reassignments at door 10?
48. Tell me about all events at Berlin doors

### Pattern Analysis
49. Which doors have the most reassignments?
50. What are the most common reasons for reassignments?
51. How many ETA updates happened today?
52. What patterns do you see in door assignments?
53. Which location has the most operational conflicts?
54. Tell me about reassignment frequency at Fremont

## Context & Inference Questions

### Causal Analysis
55. Why did priority change trigger a reassignment?
56. What factors led to the door FCX-D10 reassignment?
57. Explain the relationship between ETA slip and reassignment
58. What caused the cascade of reassignments at Fremont?
59. How did competing assignments affect door allocation?
60. What were the consequences of the truck delay?

### Comparative Analysis
61. Compare priority before and after reassignment at door FCX-D02
62. What was the priority difference that caused the change?
63. How much did the ETA slip by for truck T-FCX-179?
64. Compare ETAs before and after the update
65. Which truck had the longest delay?
66. What was the average delay time for ETA updates?

### Detail Extraction
67. What was the previous assignment before reassignment?
68. What assignment replaced the previous one at door FCX-D10?
69. Give me details about the competing assignments
70. How many assignments were overlapping?
71. What was the conflict window for the operational conflict?
72. Tell me about the assignments around the reassignment time

## Multi-Entity Questions

### Cross-Door Analysis
73. What reassignments happened across all Fremont doors?
74. Compare door FCX-D01 and FCX-D02 events
75. Which doors at Shanghai had reassignments?
76. Tell me about events across all locations
77. What patterns do you see across different doors?
78. How do Berlin events compare to Fremont events?

### Truck-Door Relationships
79. Which doors did truck T-FCX-617 use?
80. What happened to the door assigned to truck T-FCX-402?
81. Tell me about all trucks assigned to door FCX-D10
82. Which trucks caused reassignments?
83. Show me the relationship between truck delays and door changes
84. What doors were affected by late trucks?

### Location-Based Analysis
85. What events happened at Fremont CA?
86. Compare reassignment reasons across locations
87. Which location has the most stable assignments?
88. Tell me about ETA updates at Shanghai
89. What operational issues occurred at Austin TX?
90. How do different locations handle reassignments?

## Edge Cases & Complex Queries

### Vague Questions
91. What happened?
92. Tell me about reassignments
93. Why did things change?
94. What went wrong?
95. Explain the delays
96. What issues occurred?

### Specific ID Queries
97. What happened to assignment ASG-FCX-22372?
98. Tell me about event evt-73f7db04
99. Give me details on door FRE-D04
100. What's the status of truck T-FCX-617?

### Time-Based Queries
101. What events occurred in the last hour?
102. Show me yesterday's reassignments
103. What happened between 23:00 and 23:30?
104. Give me events from this morning
105. What's the most recent event at door FCX-D10?

### Aggregate Queries
106. How many events were recorded today?
107. What's the total number of reassignments?
108. Count ETA updates by location
109. How many assignments were completed?
110. What percentage of assignments were reassigned?

## Expected Response Quality Tests

### Should Include Context
111. Why was door 4 reassigned? (should find FCX-D04 and give reason + context)
112. What caused the priority change? (should extract priority delta if available)
113. Tell me about the ETA slip (should include delay minutes)
114. Explain the operational conflict (should mention competing/overlapping assignments)

### Should Link Events
115. How did the ETA update affect assignments?
116. What happened after truck T-FCX-617 was delayed?
117. Show me the chain of events from delay to reassignment
118. Explain how priority change led to door reassignment

### Should Infer Causality
119. Why did the schedule change?
120. What forced the reassignment?
121. Why was a higher priority truck chosen?
122. What made the original assignment infeasible?

## Negative Tests (Should Handle Gracefully)

### Non-Existent Entities
123. Why was door ZZZ-D99 reassigned? (should return "not found")
124. Tell me about truck T-XXX-999 (should return "not found")
125. What happened at Atlantis location? (should return "not found")

### Unrelated Questions
126. What's the weather like? (should return "unrecognized" or redirect)
127. How do I cook pasta? (should return "not dock-related")
128. What is machine learning? (should return "unknown intent")

---

## Test Coverage Summary

- **Reassignment Events**: 18 questions (priority, ETA slip, operational conflict)
- **ETA Updates**: 12 questions (delays, impacts)
- **Status Events**: 12 questions (completed, in-progress, cancelled)
- **Temporal/Pattern**: 12 questions (sequences, frequencies)
- **Context/Inference**: 18 questions (causality, comparison, details)
- **Multi-Entity**: 18 questions (cross-door, truck-door, location)
- **Edge Cases**: 28 questions (vague, specific IDs, time-based, aggregates)
- **Quality Tests**: 14 questions (context, linking, causality)
- **Negative Tests**: 6 questions (non-existent, unrelated)

**Total: 128 Test Questions**

