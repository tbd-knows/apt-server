/** Runtime processes load owner credentials from their private profile .env.
 * Never inherit platform/provider secrets from the parent API/provisioner. */
export function isolatedProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
    .flatMap(key => source[key] === undefined ? [] : [[key, source[key]!]]));
}
