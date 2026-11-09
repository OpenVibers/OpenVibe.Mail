-- phase: expand
-- Record Stalwart's outbound classification without retaining message content, and let the owner tune score cutoffs.
ALTER TABLE mail_person_sends DROP CONSTRAINT mail_person_sends_status_check;
ALTER TABLE mail_person_sends ADD CONSTRAINT mail_person_sends_status_check
    CHECK(status IN ('sending','accepted','failed','uncertain','bounced','complaint','held','refused','scoring_failed'));
ALTER TABLE mail_person_sends ADD COLUMN spam_score double precision;
ALTER TABLE mail_person_sends ADD COLUMN spam_result text;
ALTER TABLE mail_person_sends ADD COLUMN spam_outcome text;
ALTER TABLE mail_person_sends ADD COLUMN spam_scored_at timestamptz;
CREATE TABLE mail_person_spam_settings (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    hold_score double precision NOT NULL DEFAULT 5 CHECK (hold_score >= 0 AND hold_score <= 100),
    refuse_score double precision NOT NULL DEFAULT 10 CHECK (refuse_score > hold_score AND refuse_score <= 200),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO mail_person_spam_settings(id) VALUES(true);
