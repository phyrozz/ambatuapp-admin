-- DEV ONLY. Studio identity, Cognito group membership and permissions remain server-checked.
BEGIN;
INSERT INTO app.studio_modules (id,message_key,href) VALUES
 ('dashboard','studio.modules.dashboard','/dashboard'),('characters','studio.modules.characters','/'),
 ('lores','studio.modules.lores','/lores'),('videos','studio.modules.videos','/videos'),
 ('sounds','studio.modules.sounds','/sounds'),('profile-avatars','studio.modules.profileAvatars','/profile-avatars'),
 ('chat-reports','studio.modules.chatReports','/chat-reports'),('settings','studio.modules.settings','/settings'),
 ('users','studio.modules.users','/users'),('roles','studio.modules.roles','/roles') ON CONFLICT (id) DO NOTHING;
INSERT INTO app.studio_role_types (id,message_key) VALUES
 ('view','studio.actions.view'),('add','studio.actions.add'),('edit','studio.actions.edit'),
 ('delete','studio.actions.delete'),('upload','studio.actions.upload'),('download','studio.actions.download') ON CONFLICT (id) DO NOTHING;
CREATE ROLE ambatu_dev_studio_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_dev_studio_writer TO ambatu_dev_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_dev_studio_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.studio_users, app.studio_roles, app.studio_role_permissions TO ambatu_dev_studio_writer;
GRANT SELECT ON app.studio_modules, app.studio_role_types TO ambatu_dev_studio_writer;
CREATE POLICY dev_studio_users ON app.studio_users FOR ALL TO ambatu_dev_studio_writer USING (true) WITH CHECK (true);
CREATE POLICY dev_studio_roles ON app.studio_roles FOR ALL TO ambatu_dev_studio_writer USING (true) WITH CHECK (true);
CREATE POLICY dev_studio_permissions ON app.studio_role_permissions FOR ALL TO ambatu_dev_studio_writer USING (true) WITH CHECK (true);
CREATE POLICY dev_studio_modules ON app.studio_modules FOR SELECT TO ambatu_dev_studio_writer USING (true);
CREATE POLICY dev_studio_role_types ON app.studio_role_types FOR SELECT TO ambatu_dev_studio_writer USING (true);
COMMIT;
