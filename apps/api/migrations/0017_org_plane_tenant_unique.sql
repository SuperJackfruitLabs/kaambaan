-- One local tenant per Organization-plane workspace (accounts issuer contract §2, "First sight").
--
-- Partial on purpose. `agentpod` mappings stay many-to-one (migration 0002's decision); only
-- `org-plane` rows are constrained, and none exist before the P4 cutover, so this applies cleanly
-- on the automatic deploy. `ensureOrgTenant` relies on it to make concurrent first sight create
-- exactly one row.
CREATE UNIQUE INDEX tenants_org_plane_unique ON tenants(external_id) WHERE external_source = 'org-plane';
