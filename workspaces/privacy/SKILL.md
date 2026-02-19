# Privacy Agent Skills

## Workflow: PII Detection Scan

### Trigger
Receives a case ID and organization ID to scan for PII.

### Steps

1. **Assess scope**
   - `aggregate_data(caseId, "terms", "type")` — understand what types of evidence exist
   - `aggregate_data(caseId, "terms", "tags")` — check for already-scanned items (Privacy/* tags)

2. **Batch scan** (process 50 items per batch)
   - `search_evidence(caseId, size: 50, sort: "date_desc")` — get unscanned items
   - `get_item_details(caseId, itemIds)` — fetch full content

3. **NER analysis for each item**
   - `analyze_text(itemContent, "ner", entityTypes: ["person", "phone", "email", "national_id", "credit_card", "ssn", "address"])` — extract PII entities
   - Score severity based on entity type combinations (see SOUL.md table)

4. **Apply PII tags**
   - Group items by severity
   - `tag_items(caseId, orgId, "Privacy/PII-High", highSeverityIds)`
   - `tag_items(caseId, orgId, "Privacy/PII-Medium", mediumSeverityIds)`
   - `tag_items(caseId, orgId, "Privacy/PII-Low", lowSeverityIds)`
   - `tag_items(caseId, orgId, "Privacy/Clean", cleanIds)`

5. **Escalate high-severity findings**
   - For HIGH severity items:
   - `create_task(title: "Review PII: X high-severity items", orgId, caseId, assignedTo: [privacyOfficerId], priority: "HIGH", tags: ["privacy", "pii-review"])`
   - Include in task description: count by PII type (redacted), item IDs

6. **Compliance audit log**
   - `log_audit("pii_detected", "evidence", null, severity, "privacy", {gdprRelevant: true, ccpaRelevant: true}, details)`
   - Log summary: "Scanned X items. Found Y HIGH, Z MEDIUM PII items."

7. **Generate report**
   - `generate_report(caseId, "evidence-statistics")` — PII summary

### Error Handling
- If NER fails on an item, tag as `Privacy/Needs-Scan` and continue
- Never include raw PII in error logs or notifications
