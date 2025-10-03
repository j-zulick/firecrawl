/**
 * Utility functions for URL manipulation and analysis
 */

/**
 * Determines if a URL is a base domain (e.g., example.com vs blog.example.com or example.com/path)
 * A base domain is considered to be the root domain without subdomains or paths
 * @param url - The URL to check
 * @returns true if the URL is a base domain, false otherwise
 */
export function isBaseDomain(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // Remove www. prefix for consistency
    const cleanHostname = hostname.startsWith("www.")
      ? hostname.slice(4)
      : hostname;

    // Check if there are subdomains (more than 2 parts when split by dots)
    const parts = cleanHostname.split(".");
    if (parts.length > 2) {
      return false; // Has subdomains
    }

    // Check if there's a path beyond the root
    const pathname = urlObj.pathname;
    if (pathname && pathname !== "/" && pathname.trim() !== "") {
      return false; // Has a path
    }

    return true;
  } catch (error) {
    // If URL parsing fails, consider it not a base domain
    return false;
  }
}

/**
 * Extracts the base domain from a URL
 * @param url - The URL to extract base domain from
 * @returns The base domain (e.g., "example.com") or null if extraction fails
 */
export function extractBaseDomain(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // Remove www. prefix for consistency
    const cleanHostname = hostname.startsWith("www.")
      ? hostname.slice(4)
      : hostname;

    // Extract the base domain
    const parts = cleanHostname.split(".");
    if (parts.length >= 2) {
      // Handle special cases for multi-part TLDs like .co.uk, .com.au, etc.
      const lastTwoParts = parts.slice(-2).join(".");

      // Common multi-part TLDs that should be treated as single TLD
      const multiPartTlds = [
        "co.uk",
        "com.au",
        "org.uk",
        "net.uk",
        "ac.uk",
        "gov.uk",
        "co.nz",
        "com.br",
        "co.jp",
        "co.kr",
        "co.in",
        "co.za",
      ];

      if (multiPartTlds.includes(lastTwoParts) && parts.length >= 3) {
        // For domains like subdomain.example.co.uk, return example.co.uk
        return parts.slice(-3).join(".");
      } else {
        // For regular domains like example.com, return the last 2 parts
        return lastTwoParts;
      }
    }

    return cleanHostname;
  } catch (error) {
    return null;
  }
}
