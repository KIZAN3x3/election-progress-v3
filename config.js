const SUPABASE_URL = 'https://hhlqgxmhbpfhjnjmradq.supabase.co';
let SUPABASE_KEY = null;

// Classic script: auth.js waits for this promise before constructing its client.
// Never reject outside the auth/UI error boundary or fall back to an embedded key.
const SUPABASE_CONFIG_READY = (async () => {
  let timeout;
  try {
    const controller = new AbortController();
    const load = (async () => {
      const response = await fetch(SUPABASE_URL + '/functions/v1/v3-public-config', {
        method: 'GET', mode: 'cors', credentials: 'omit', signal: controller.signal
      });
      if(!response.ok) throw new Error('Public configuration unavailable');
      const data = await response.json();
      if(!data || typeof data !== 'object' || Array.isArray(data) ||
        !Object.hasOwn(data, 'publishable_key') || typeof data.publishable_key !== 'string' ||
        !data.publishable_key.startsWith('sb_publishable_') ||
        data.publishable_key.length <= 'sb_publishable_'.length || /[^A-Za-z0-9_-]/.test(data.publishable_key)) {
        throw new Error('Public configuration unavailable');
      }
      return data.publishable_key;
    })();
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Public configuration unavailable'));
      }, 8000);
    });
    SUPABASE_KEY = await Promise.race([load, deadline]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
})();
