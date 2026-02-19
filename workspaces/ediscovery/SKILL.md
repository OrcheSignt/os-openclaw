# eDiscovery Agent Skills

## Workflow: Classify Case Evidence

### Trigger
Receives a case ID and organization ID to process.

### Steps

1. **Assess scope**
   - `aggregate_data(caseId, "terms", "type")` — understand evidence types
   - `aggregate_data(caseId, "terms", "tags")` — see what's already tagged
   - Calculate unreviewed count = total - already-tagged

2. **Batch process** (repeat until all items reviewed)
   - `search_evidence(caseId, filters: [{field: "tags", value: "eDiscovery/*"}], size: 50, sort: "date_desc")` — get unreviewed items (negate the filter to exclude already-tagged)
   - `get_item_details(caseId, itemIds)` — fetch full content for the batch

3. **Classify each item**
   - `analyze_text(text, "classify", categories: ["relevant", "privileged", "non_responsive", "needs_review"])` — ML classification
   - For items scoring > 0.7 on "privileged": double-check with keyword scan for attorney names, "privileged", "confidential", "work product"

4. **Apply tags**
   - Group items by classification result
   - `tag_items(caseId, orgId, "eDiscovery/Relevant", itemIds)` — for each category
   - `tag_items(caseId, orgId, "eDiscovery/Privileged", itemIds)` — privileged items

5. **Escalate privileged items**
   - For any items tagged as privileged:
   - `create_notification(leadReviewerId, "Privileged Items Found", message, "warning", "CRITICAL", actionUrl)`

6. **Audit and progress**
   - `log_audit("evidence_classified", "evidence", null, "LOW", "ediscovery", {details: "Classified X items: Y relevant, Z privileged..."})`
   - `update_case_progress(caseId, progressPercentage)` — based on reviewed/total

7. **Generate report** (after completing all batches)
   - `generate_report(caseId, "evidence-statistics")` — summary report

### Error Handling
- If ML classification fails, tag items as `eDiscovery/Needs-Review`
- If gateway errors occur, retry the batch once, then skip and log
- Always update progress even if some batches fail
