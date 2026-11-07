# BFF platform

- Preserve the Art components, theme tokens, and metadata-driven ArtForm/ArtTableQuery patterns inherited from the pro main repository. Read the retained project-code-quality, frontend conventions, and professional-ui-quality skills before source/UI work.
- Identity belongs to `ckbftoopuyophiebamwy` (pro). BFF business data belongs to `bksbwnxdurmuolygiofh`. Never direct a BFF schema statement at pro.
- Pro changes must be additive, isolated from existing login/business functionality, and verified in both repositories. Preserve unrelated user changes.
- Authentication uses OAuth authorization code + PKCE through the BFF server. Tokens and service keys must never reach frontend storage or responses. Sessions use opaque HttpOnly cookies.
- Authorization comes from active BFF memberships; never infer BFF administrator permissions from email, user-editable metadata, or successful authentication alone.
- No per-version migration SQL files. Maintain the canonical BFF schema in `server/database/schema.sql`, apply deliberately through the scoped CLI, and verify database permissions and tenant isolation.
- Business navigation is delivered by the authenticated backend session. Public routes are limited to auth and error/framework routes.

- Shared pro pages must use the complete published pro interface. Do not pass host-specific profile, canEdit, organizationScope, or layout-trimming flags. Keep BFF data and authorization integration in API providers and server handlers, publish shared changes in pro, and upgrade this repository to that fixed package release.
