SELECT key, length(value) AS len,
  left(value, 40) AS head,
  (value LIKE 'ssh-%') AS ok_prefix,
  (value LIKE '%BEGIN%') AS has_begin
FROM "Setting"
WHERE key IN ('ANSIBLE_FORGE_PRIVATE_KEY','ANSIBLE_FORGE_PUBLIC_KEY','ANSIBLE_ADMIN_PUBKEY','ANSIBLE_SERVICE_USER','ANSIBLE_BOOTSTRAP_CLOUDINIT','ANSIBLE_ENABLED');
