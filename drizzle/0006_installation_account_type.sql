-- Existing rows stay null until a GitHub lifecycle event supplies the account type.
-- The Channels screen withholds type-specific links for those rows instead of guessing.
ALTER TABLE "github_installation" ADD COLUMN "account_type" text;
