-- Register the Scroll ads module so Studio roles can be granted access.
BEGIN;
INSERT INTO app.studio_modules (id, message_key, href)
VALUES ('scroll-ads', 'studio.modules.scrollAds', '/scroll-ads')
ON CONFLICT (id) DO NOTHING;
COMMIT;
