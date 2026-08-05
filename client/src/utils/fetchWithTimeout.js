      signal: controller.signal,
      headers: {
        ...options.headers,
        // ngrok serves a browser warning page for requests that do not carry
        // the ngrok-skip-browser-warning header, causing JSON parse and connection errors
        'ngrok-skip-browser-warning': 'true',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    
    clearTimeout(timeoutId);
    
    // Keep non-2xx responses intact. The API client needs the status and JSON
    // body to distinguish an auth failure from a genuinely unreachable tunnel.
    return response;
  } catch (error) {
    clearTimeout(timeoutId);