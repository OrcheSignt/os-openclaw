# Case Recommendations — Workflow & Output Schemas

## Workflow 1: Full Analysis

Execute these steps in order. Each step builds on previous results.

### Step 1 — Scope Assessment
```
aggregate_data(caseId, "terms", "type", size=20)
aggregate_data(caseId, "terms", "tags.tag", size=20)
aggregate_data(caseId, "date_histogram", "timestamp", interval="1M")
```
Understand: total items, types of evidence, existing tags, date range.

### Step 2 — Build Timeline
```
build_timeline(caseId, date_from=<earliest>, date_to=<latest>, size=50)
```
Establish chronological narrative of events.

### Step 3 — Identify Key Entities
```
aggregate_data(caseId, "terms", "communication.from.name.keyword", size=15)
aggregate_data(caseId, "terms", "communication.to.name.keyword", size=15)
```
For top 3-5 entities:
```
search_by_entity(caseId, entity=<name>)
```

### Step 4 — Cross-Reference Key Relationships
For the most significant entity pairs:
```
cross_reference(caseId, entity_a=<name1>, entity_b=<name2>, max_hops=2)
```

### Step 5 — Sensitive Content Scan
```
search_evidence(caseId, query="privileged OR confidential OR attorney OR classified", size=10)
search_evidence(caseId, query="password OR credential OR unauthorized access", size=10)
```

### Step 6 — Fetch Legal References
```
get_legal_references(jurisdiction=<case_jurisdiction>, case_type=<case_type>)
```
If no jurisdiction set on case, note this gap and use general principles.

### Step 7 — Generate Case Summary
Produce `case_summary` structured JSON (schema below) and save:
```
save_case_recommendation(caseId, orgId, type="case_summary", content=<markdown>, structured=<json>)
```

### Step 8 — Generate Legal Challenges
Produce `legal_challenges` structured JSON and save:
```
save_case_recommendation(caseId, orgId, type="legal_challenges", content=<markdown>, structured=<json>)
```

### Step 9 — Generate Relevant Law
Produce `relevant_law` structured JSON and save:
```
save_case_recommendation(caseId, orgId, type="relevant_law", content=<markdown>, structured=<json>)
```

### Step 10 — Notify & Audit
```
create_notification(userId=<lead_investigator>, title="Case Recommendations Ready", message="...", type="info", priority="MEDIUM")
log_audit(action="generate_recommendations", resourceType="case", resourceId=<caseId>, severity="INFO", category="analysis")
```

---

## Workflow 2: Targeted Refinement

When `task_description` specifies a particular section to update:

1. Parse which section(s) need updating
2. Load existing recommendation via context
3. Perform additional targeted searches based on the refinement request
4. Update only the specified section(s) via `save_case_recommendation`
5. Log audit

---

## Output Schemas

### case_summary.structured

```json
{
  "overview": "string — 2-3 paragraph narrative overview of the case",
  "keyFindings": [
    {
      "title": "string",
      "description": "string",
      "severity": "LOW | MEDIUM | HIGH | CRITICAL",
      "evidenceIds": ["string"],
      "confidence": "HIGH | MEDIUM | LOW"
    }
  ],
  "evidenceBreakdown": {
    "total": "number",
    "byType": [
      { "type": "string", "count": "number", "percentage": "number" }
    ]
  },
  "timeline": [
    {
      "date": "ISO date string",
      "event": "string",
      "significance": "string",
      "evidenceIds": ["string"]
    }
  ],
  "personsOfInterest": [
    {
      "name": "string",
      "role": "string — e.g. suspect, witness, victim",
      "relevance": "string",
      "communicationCount": "number",
      "connectedEntities": ["string"]
    }
  ],
  "conclusions": [
    {
      "conclusion": "string",
      "supportingEvidence": "string",
      "nextSteps": "string"
    }
  ]
}
```

### legal_challenges.structured

```json
{
  "jurisdiction": {
    "country": "string",
    "state": "string | null",
    "legalSystem": "string",
    "notes": "string"
  },
  "admissibilityIssues": [
    {
      "issue": "string",
      "affectedEvidence": "string — description or IDs",
      "risk": "LOW | MEDIUM | HIGH | CRITICAL",
      "mitigation": "string",
      "legalBasis": "string — law citation"
    }
  ],
  "chainOfCustodyGaps": [
    {
      "gap": "string",
      "affectedItems": "string",
      "risk": "LOW | MEDIUM | HIGH",
      "recommendation": "string"
    }
  ],
  "jurisdictionalProblems": [
    {
      "problem": "string",
      "affectedEvidence": "string",
      "recommendation": "string"
    }
  ],
  "proceduralConcerns": [
    {
      "concern": "string",
      "risk": "LOW | MEDIUM | HIGH",
      "recommendation": "string"
    }
  ],
  "overallAssessment": "string — balanced 2-3 paragraph assessment of legal posture"
}
```

### relevant_law.structured

```json
{
  "applicableLaws": [
    {
      "name": "string",
      "nameLocal": "string | null",
      "citation": "string",
      "relevance": "string — why this law matters for this case",
      "jurisdiction": "string",
      "category": "string",
      "keySections": ["string"]
    }
  ],
  "keyStatutes": [
    {
      "statute": "string",
      "citation": "string",
      "applicability": "string — how it applies to the specific evidence"
    }
  ],
  "precedents": [
    {
      "caseName": "string",
      "citation": "string",
      "holding": "string",
      "relevance": "string"
    }
  ],
  "disclaimers": [
    "⚠️ AI-generated analysis — not legal advice. Review by qualified legal counsel is required.",
    "Legal references sourced from curated database. Verify currency and applicability with legal counsel."
  ]
}
```

---

## Content Format for `content` Field

The `content` field in each recommendation should be **markdown** suitable for display in the AI chat and for use as the basis of PDF reports. Structure with headings, bullet points, and tables where appropriate.
