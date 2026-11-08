-- Budgeted, on-demand media. Apply after 010; do not edit the applied schema.
BEGIN;
ALTER TABLE app.dream_media_jobs ADD COLUMN reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0);
UPDATE app.dream_media_jobs SET reserved_bytes=cardinality(prefixes)::bigint*210763776 WHERE state='pending';
CREATE TABLE app.dream_media_costs (
  month date PRIMARY KEY,
  uploads integer NOT NULL DEFAULT 0,upload_bytes bigint NOT NULL DEFAULT 0,
  requests integer NOT NULL DEFAULT 0,delivery_bytes bigint NOT NULL DEFAULT 0,
  worker_starts integer NOT NULL DEFAULT 0,worker_seconds integer NOT NULL DEFAULT 0,
  gateway_seconds integer NOT NULL DEFAULT 0,
  CHECK(uploads>=0 AND upload_bytes>=0 AND requests>=0 AND delivery_bytes>=0 AND worker_starts>=0 AND worker_seconds>=0 AND gateway_seconds>=0)
);
CREATE TABLE app.dream_gateway_leases(id uuid PRIMARY KEY,month date NOT NULL,started_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE app.dream_gateway_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.dream_gateway_leases FROM PUBLIC;
CREATE TABLE app.dream_worker_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  lease_id uuid,task_arn text,started_at timestamptz,charged_until timestamptz,deadline timestamptz,request_json jsonb
);
INSERT INTO app.dream_worker_control(singleton) VALUES(true);
ALTER TABLE app.dream_media_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dream_worker_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.dream_media_costs,app.dream_worker_control FROM PUBLIC;
DO $private$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON app.dream_media_costs,app.dream_worker_control,app.dream_gateway_leases FROM %I',r); END IF;
  END LOOP;
END $private$;
GRANT SELECT,INSERT,UPDATE ON app.dream_media_costs,app.dream_worker_control TO ambatu_prod_dream_worker;
GRANT SELECT,DELETE ON app.dream_gateway_leases TO ambatu_prod_dream_worker;
CREATE POLICY prod_dream_gateway_worker ON app.dream_gateway_leases FOR ALL TO ambatu_prod_dream_worker USING(true) WITH CHECK(true);
CREATE POLICY prod_dream_cost_worker ON app.dream_media_costs FOR ALL TO ambatu_prod_dream_worker USING(true) WITH CHECK(true);
CREATE POLICY prod_dream_control_worker ON app.dream_worker_control FOR ALL TO ambatu_prod_dream_worker USING(true) WITH CHECK(true);

-- Only narrowly scoped wrappers are executable by the API/gateway roles.
CREATE FUNCTION app._dream_media_charge(kind text,amount bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $charge$
DECLARE m date=(date_trunc('month',now() AT TIME ZONE 'UTC'))::date; b app.dream_media_costs; footprint bigint;
BEGIN
  IF kind NOT IN ('request','delivery','upload') OR amount<0 OR amount>209715200 THEN RETURN false; END IF;
  INSERT INTO app.dream_media_costs(month) VALUES(m) ON CONFLICT DO NOTHING;
  SELECT * INTO b FROM app.dream_media_costs WHERE month=m FOR UPDATE;
  IF kind='request' THEN
    IF amount<>1 OR b.requests>=50000 THEN RETURN false; END IF;
    UPDATE app.dream_media_costs SET requests=requests+1 WHERE month=m;
  ELSIF kind='delivery' THEN
    IF b.delivery_bytes+amount>10737418240 THEN RETURN false; END IF;
    UPDATE app.dream_media_costs SET delivery_bytes=delivery_bytes+amount WHERE month=m;
  ELSE
    SELECT coalesce(sum(a.declared_bytes+1048576+CASE WHEN a.state='ready' THEN a.output_bytes ELSE CASE WHEN a.kind='image' THEN 10485760 ELSE 209715200 END END),0) INTO footprint FROM app.dream_attachments a;
    SELECT footprint+coalesce(sum(reserved_bytes),0) INTO footprint FROM app.dream_media_jobs WHERE state='pending';
    IF amount<1 OR b.uploads>=200 OR b.upload_bytes+amount>1073741824 OR footprint+amount+210763776>5368709120 OR b.worker_seconds>=21600 OR b.worker_starts>=100 THEN RETURN false; END IF;
    UPDATE app.dream_media_costs SET uploads=uploads+1,upload_bytes=upload_bytes+amount WHERE month=m;
  END IF;
  RETURN true;
END $charge$;
REVOKE ALL ON FUNCTION app._dream_media_charge(text,bigint) FROM PUBLIC;
CREATE FUNCTION app.dream_media_request() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS 'SELECT app._dream_media_charge(''request'',1)';
CREATE FUNCTION app.dream_media_delivery(bytes bigint) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS 'SELECT app._dream_media_charge(''delivery'',bytes)';
CREATE FUNCTION app.dream_media_upload(bytes bigint) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS 'SELECT app._dream_media_charge(''upload'',bytes)';
REVOKE ALL ON FUNCTION app.dream_media_request(),app.dream_media_delivery(bigint),app.dream_media_upload(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dream_media_request(),app.dream_media_delivery(bigint) TO ambatu_prod_dream_media_reader;
GRANT EXECUTE ON FUNCTION app.dream_media_upload(bigint) TO ambatu_prod_dream_writer;

-- Reserve the entire Lambda timeout before serving, then refund unused time.
-- A timeout/crash keeps its full reservation. A lease can be refunded only once.
CREATE FUNCTION app.dream_media_begin() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $begin$
DECLARE m date=(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC'))::date; token uuid=gen_random_uuid(); b app.dream_media_costs;
BEGIN
  INSERT INTO app.dream_media_costs(month) VALUES(m) ON CONFLICT DO NOTHING;
  SELECT * INTO b FROM app.dream_media_costs WHERE month=m FOR UPDATE;
  IF b.requests>=50000 OR b.gateway_seconds+180>100000 OR b.delivery_bytes>=10737418240 THEN RETURN NULL; END IF;
  UPDATE app.dream_media_costs SET requests=requests+1,gateway_seconds=gateway_seconds+180 WHERE month=m;
  INSERT INTO app.dream_gateway_leases(id,month) VALUES(token,m);
  RETURN token;
END $begin$;
CREATE FUNCTION app.dream_media_finish(token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $finish$
DECLARE lease app.dream_gateway_leases; seconds integer;
BEGIN
  DELETE FROM app.dream_gateway_leases WHERE id=token RETURNING * INTO lease;
  IF NOT FOUND THEN RETURN; END IF;
  seconds=least(180,greatest(1,ceil(extract(epoch FROM clock_timestamp()-lease.started_at))::integer));
  UPDATE app.dream_media_costs SET gateway_seconds=gateway_seconds-(180-seconds) WHERE month=lease.month;
END $finish$;
REVOKE ALL ON FUNCTION app.dream_media_begin(),app.dream_media_finish(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dream_media_begin(),app.dream_media_finish(uuid) TO ambatu_prod_dream_media_reader;
-- Supabase may grant these roles EXECUTE through ALTER DEFAULT PRIVILEGES.
-- Revoking PUBLIC alone does not remove such direct grants.
DO $functions$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app._dream_media_charge(text,bigint),app.dream_media_request(),app.dream_media_delivery(bigint),app.dream_media_upload(bigint),app.dream_media_begin(),app.dream_media_finish(uuid) FROM %I',r);
    END IF;
  END LOOP;
END $functions$;
COMMIT;
