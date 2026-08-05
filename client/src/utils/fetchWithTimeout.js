/**
 * Enhanced fetch with timeout support to prevent hanging requests
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<Response>} - Fetch response
 */
export const fetchWithTimeout = async (url, options = {}, timeout = 8000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...options.headers,
        // ngrok serves a browser warning page for requests that do not carry
        // the ngrok-skip-browser-warning header, causing JSON parse and connection errors
        'ngrok-skip-browser-warning': 'true',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    
    clearTimeout(timeoutId);
    
    // Keep non-2xx responses intact. The API client needs the status and JSON
    // body to distinguish an auth failure from a genuinely unreachable tunnel.
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error(`Request to ${url} timed out after ${timeout}ms`);
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw error;
  }
};

/**
 * Custom hook for API data fetching with retry and exponential backoff
 * @param {Function} fetchFunction - The function to fetch data
 * @param {number} initialDelay - Initial delay in milliseconds
 * @param {number} maxRetries - Maximum number of retries
 * @returns {object} - Data, loading state, error, and refetch function
 */
export const createBackoffFetcher = (fetchFunction, initialDelay = 3000, maxRetries = 3) => {
  let currentDelay = initialDelay;
  let retries = 0;
  let activeRequestTimestamp = null;
  
  // Return an enhanced version of the fetch function with retry logic
  return async () => {
    // Generate unique request ID
    const requestTimestamp = Date.now();
    activeRequestTimestamp = requestTimestamp;
    
    try {
      const response = await fetchFunction();
      // On success, reset retry parameters
      retries = 0;
      currentDelay = initialDelay;
      return response;
    } catch (error) {
      // Only process if this is still the active request
      if (requestTimestamp !== activeRequestTimestamp) {
        throw error;
      }
      
      // If we've hit max retries, throw the error
      if (retries >= maxRetries) {
        retries = 0; // Reset for next time
        currentDelay = initialDelay;
        throw error;
      }
      
      // Otherwise, increment retries and apply exponential backoff
      retries++;
      const backoffDelay = currentDelay;
      currentDelay = Math.min(currentDelay * 1.5, 30000); // Max 30 seconds
      
      console.log(`Retrying after ${backoffDelay}ms (attempt ${retries}/${maxRetries})`);
      
      // Wait for the backoff period
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
      
      // Try again recursively
      return fetchFunction();
    }
  };
};
