# Cyber Threat Agent Skills

## Workflow: Threat Analysis

### Trigger
Receives a case ID and organization ID for cyber threat analysis.

### Steps

1. **Case overview**
   - `aggregate_data(caseId, "terms", "type")` — evidence type distribution
   - `aggregate_data(caseId, "terms", "source")` — data sources
   - `aggregate_data(caseId, "date_histogram", "timestamp", interval: "1d")` — activity timeline

2. **IOC keyword search**
   - `search_evidence(caseId, query: "malware OR trojan OR ransomware OR phishing", size: 50)` — malware keywords
   - `search_evidence(caseId, query: "cmd.exe OR powershell OR base64 OR wget OR curl", size: 50)` — suspicious commands
   - `search_evidence(caseId, filters: [{field: "type", value: "network"}], size: 50)` — network traffic items

3. **NER extraction on suspicious items**
   - `get_item_details(caseId, suspiciousItemIds)` — full content
   - `analyze_text(content, "ner")` — extract technical entities (IPs, domains, hashes)
   - Collect all extracted IOCs into a threat map

4. **Threat classification**
   - `analyze_text(content, "classify", categories: ["malware", "phishing", "data_exfiltration", "c2_communication", "lateral_movement", "benign"])` — ML classification
   - Cross-reference with IOC patterns for confidence boosting

5. **Image forensics**
   - For image-type evidence:
   - `analyze_image(caseId, itemId, "ocr")` — extract text from screenshots
   - If OCR text contains commands/configs, run NER and classification on extracted text

6. **Apply threat tags**
   - `tag_items(caseId, orgId, "Cyber/Malware", malwareIds)`
   - `tag_items(caseId, orgId, "Cyber/Phishing", phishingIds)`
   - `tag_items(caseId, orgId, "Cyber/Data-Exfil", exfilIds)`
   - `tag_items(caseId, orgId, "Cyber/C2", c2Ids)`
   - `tag_items(caseId, orgId, "Cyber/IoC", iocIds)`
   - `tag_items(caseId, orgId, "Cyber/Benign", benignIds)`

7. **Immediate threat escalation**
   - For confirmed threats (malware, C2, data exfil):
   - `create_notification(securityLeadId, "THREAT DETECTED: [type]", details, "error", "CRITICAL")`
   - `create_task(title: "Investigate [threat type]: [summary]", orgId, caseId, priority: "CRITICAL")`

8. **Enrichment** (if needed)
   - `trigger_enrichment(caseId, "entity_extraction")` — deep NER on full case
   - `get_pipeline_status(jobId)` — monitor progress

9. **Audit and report**
   - `log_audit("threat_analysis_complete", "case", caseId, severity, "cyber")`
   - `generate_report(caseId, "evidence-statistics")`

### Error Handling
- If ML classification is unavailable, fall back to keyword-based heuristics
- Always log audit even if analysis is partial
- Never delay CRITICAL notifications for batch completion
