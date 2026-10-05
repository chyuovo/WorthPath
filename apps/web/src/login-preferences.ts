export function savedLogin(): { username: string; remember: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem('worthpath.login') || '{}');
    return {
      username: typeof value.username === 'string' ? value.username : '',
      remember: value.remember === true,
    };
  } catch {
    return { username: '', remember: false };
  }
}
export async function rememberLogin(username: string, password: string, remember: boolean) {
  try {
    if (remember)
      localStorage.setItem('worthpath.login', JSON.stringify({ username, remember: true }));
    else localStorage.removeItem('worthpath.login');
  } catch {
    /* Login remains usable when local storage is unavailable. */
  }
  if (!remember) return;
  const Password = (
    window as unknown as {
      PasswordCredential?: new (data: { id: string; password: string; name: string }) => Credential;
    }
  ).PasswordCredential;
  if (Password && navigator.credentials && window.isSecureContext) {
    try {
      await navigator.credentials.store(new Password({ id: username, password, name: username }));
    } catch {
      /* The browser can still offer its normal password save prompt. */
    }
  }
}
