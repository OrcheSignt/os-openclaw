# Compliance Agent Skills

## Workflow: Daily Compliance Scan

### Trigger
Scheduled daily at 06:00 UTC, or triggered manually with a case ID.

### Steps

1. **Case overview**
   - `aggregate_data(caseId, "terms", "tags", size: 50)` — all tags and their counts
   - `aggregate_data(caseId, "terms", "type")` — total items by type
   - Calculate: total items, tagged items, untagged items, tag coverage %

2. **Identify gaps**
   - `search_evidence(caseId, size: 10, filters: [])` — sample untagged items to verify
   - Compare tagged count vs total count for coverage metric
   - Check for required tag categories: eDiscovery/*, Privacy/*, Cyber/*

3. **Create remediation tasks**
   - For each gap category:
   - `create_task(title: "Review gap: X untagged items need [category] review", orgId, caseId, priority, tags: ["compliance", "remediation"])`
   - Include in description: gap type, item count, recommended action

4. **Generate compliance report**
   - `generate_report(caseId, "evidence-statistics")` — full statistics report
   - Compile metrics:
     - Tag coverage: X%
     - eDiscovery reviewed: X%
     - Privacy scanned: X%
     - Cyber analyzed: X%
     - Open tasks: X
     - Overdue tasks: X

5. **Notify case lead**
   - `create_notification(caseLeadId, "Compliance Report: [case name]", summary, type, priority)`
   - Priority based on coverage: >90% = LOW, 70-90% = MEDIUM, <70% = HIGH

6. **Audit log**
   - `log_audit("compliance_scan", "case", caseId, severity, "compliance")`
   - Details: full metrics summary

7. **Update case progress**
   - `update_case_progress(caseId, overallProgress)` — based on combined review metrics

### Error Handling
- If aggregation fails, log the error and notify with "DEGRADED" status
- Always complete the audit log even if other steps fail
- If report generation fails, include metrics in the notification body instead
