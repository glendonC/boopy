-- Synthetic local SQLite contract only. Zetaris dialect/schema/binding remain unverified.
SELECT c.evidence_id, c.revision_id, c.captured_at, c.context_text,
       c.human_verification, c.model_confidence,
       r.reference_id, r.korean_term, r.reference_version, r.updated_at,
       r.reference_status, r.reference_url
FROM selected_context c
JOIN independent_reference r ON c.concept_key = r.concept_key
WHERE c.package_id = :package_id AND c.export_grant_id = :grant_id
  AND c.superseded_by IS NULL
  AND c.human_verification IN ('unconfirmed', 'confirmed')
ORDER BY c.evidence_id, r.reference_id;
