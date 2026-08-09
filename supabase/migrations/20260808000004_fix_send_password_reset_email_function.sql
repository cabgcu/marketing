-- ============================================================================
-- Fix send_password_reset_email() to use the normalized tables
-- ============================================================================
-- This is a separate SQL function from the send-password-reset Edge
-- Function — the client calls this one directly via
-- _supabase.rpc('send_password_reset_email', ...), and it independently
-- calls Brevo via the `http` Postgres extension. It was never updated when
-- the rest of the app moved off app_state, so it was reading/writing the
-- now-frozen app_state blob directly: user lookups couldn't see anyone
-- added after the cutover, and tokens it wrote went into a document
-- nothing else reads anymore.
--
-- This does not fix a separate Brevo-side "API Key is not enabled" error
-- some accounts hit on the transactional email endpoint — that needs to be
-- resolved in the Brevo dashboard (key scope / sender verification), this
-- migration only fixes which tables the function reads and writes.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.send_password_reset_email(p_email text, p_app_url text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_brevo_key   TEXT;
  v_user_email  TEXT;
  v_user_name   TEXT;
  v_token       TEXT;
  v_expiry      BIGINT;
  v_reset_url   TEXT;
  v_body        TEXT;
  v_http_resp   http_response;
BEGIN
  SELECT value INTO v_brevo_key FROM app_secrets WHERE key = 'BREVO_API_KEY';
  IF v_brevo_key IS NULL THEN RETURN '{"error":"Email service not configured"}'::JSONB; END IF;

  SELECT email, name INTO v_user_email, v_user_name
  FROM users WHERE lower(email) = lower(p_email) LIMIT 1;

  -- Return success regardless to avoid email enumeration
  IF NOT FOUND THEN RETURN '{"success":true}'::JSONB; END IF;

  v_token     := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  v_expiry    := (extract(epoch from now()) * 1000)::BIGINT + 3600000;
  v_user_name := COALESCE(NULLIF(v_user_name,''), split_part(lower(p_email),'@',1));
  v_reset_url := p_app_url || '?reset=' || v_token;

  -- password_reset_tokens is its own table now — remove any prior token for
  -- this email, then insert the new one, instead of read-modify-writing the
  -- whole app_state blob.
  DELETE FROM password_reset_tokens WHERE email = lower(p_email);
  INSERT INTO password_reset_tokens (token, email, expiry) VALUES (v_token, lower(p_email), v_expiry);

  v_body := json_build_object(
    'sender',      json_build_object('name','CAB Marketing','email','noreply@cabgcu.com'),
    'to',          json_build_array(json_build_object('email',lower(p_email),'name',v_user_name)),
    'subject',     'Reset Your Password – CAB Marketing',
    'htmlContent', '<html><body style="margin:0;padding:0;background:#0a0a0a;font-family:sans-serif"><table width="100%" style="padding:40px 20px"><tr><td align="center"><table width="100%" style="max-width:480px;background:#111;border-radius:20px;border:1px solid rgba(255,255,255,0.1)"><tr><td style="padding:36px;text-align:center;background:linear-gradient(135deg,#6c63ff,#e056fd)"><h1 style="margin:0;color:#fff;font-size:1.6rem;font-weight:800">Reset Your Password</h1></td></tr><tr><td style="padding:32px"><p style="color:#ccc;margin:0 0 16px">Hi ' || v_user_name || ',</p><p style="color:#ccc;margin:0 0 24px">Click below to reset the password for <strong style="color:#fff">' || lower(p_email) || '</strong>. Expires in 1 hour.</p><div style="text-align:center;margin-bottom:24px"><a href="' || v_reset_url || '" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#6c63ff,#e056fd);color:#fff;text-decoration:none;border-radius:12px;font-weight:700">Reset Password</a></div><p style="font-size:0.8rem;color:#555;text-align:center;margin:0">If you did not request this, ignore this email.</p></td></tr></table></td></tr></table></body></html>'
  )::TEXT;

  SELECT * INTO v_http_resp FROM http((
    'POST',
    'https://api.brevo.com/v3/smtp/email',
    ARRAY[
      http_header('api-key', v_brevo_key),
      http_header('Content-Type', 'application/json')
    ],
    'application/json',
    v_body
  )::http_request);

  IF v_http_resp.status NOT BETWEEN 200 AND 299 THEN
    RAISE LOG 'Brevo error %: %', v_http_resp.status, v_http_resp.content;
    RETURN jsonb_build_object('error', 'Email delivery failed: ' || v_http_resp.status);
  END IF;

  RETURN '{"success":true}'::JSONB;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'send_password_reset_email error: %', SQLERRM;
  RETURN jsonb_build_object('error', SQLERRM);
END;
$function$;

grant execute on function send_password_reset_email(text, text) to anon, authenticated;
