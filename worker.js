addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
  });
  
  async function handleRequest(request) {
    const url = new URL(request.url);
    const targetHost = 'duckduckgo.com';
    const targetUrl = `https://${targetHost}${url.pathname}${url.search}${url.hash}`;
  
    try {
      const headers = new Headers(request.headers);
      headers.delete('Host');
      headers.delete('X-Forwarded-For');
      headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8');
      headers.set('User-Agent', headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: 'manual'
      });
  
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('Content-Security-Policy');
      responseHeaders.set('Access-Control-Allow-Origin', '*');
  
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      }
  
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const reader = response.body.getReader();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
  
      const proxyBase = `${url.protocol}//${url.host}/`;
      const targetOrigin = `https://${targetHost}`;
      const urlPatterns = [
        { regex: /(href|src|action)="([^"]*)"/gi, attr: 1 },
        { regex: /(href|src|action)='([^']*)'/gi, attr: 1 },
        { regex: /url\(['"]?([^'"]*)['"]?\)/gi, attr: 1 },
        { regex: /<meta[^>]*refresh[^>]*url=([^>\s]*)[^>]*>/gi, attr: 1 },
        { regex: /(window\.location|location\.href|location\.assign|location\.replace)\s*=\s*['"]([^'"]*)['"]/gi, attr: 2 },
        { regex: /data-(url|href|target|nav|link)="([^"]*)"/gi, attr: 1 },
        { regex: /data-(url|href|target|nav|link)='([^']*)'/gi, attr: 1 },
        { regex: /"(\/[^"]*)"/g, attr: 1 },
        { regex: /'(\/[^']*)'/g, attr: 1 },
        { regex: /(?<=[\s(])\/[^/\s][^\s"']*(?=[;\s"']|$)/g, attr: 0 },
        { regex: /(onclick|onchange|onsubmit)="([^"]*)"/gi, attr: 1 },
        { regex: /(onclick|onchange|onsubmit)='([^']*)'/gi, attr: 1 }
      ];
  
      (async () => {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer) {
              writer.write(encoder.encode(rewriteChunk(buffer, targetOrigin, proxyBase, urlPatterns)));
            }
            const script = `
              <script>
                function replaceDuckTextAndLogo() {
                  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                  while (walker.nextNode()) {
                    const node = walker.currentNode;
                    node.nodeValue = node.nodeValue.replace(/\\bDuckDuckGo\\b/gi, 'ArcArcGo').replace(/\\bDuckDuckGo's\\b/gi, "ArcArcGo's");
                  }
                  document.title = document.title.replace(/\\bDuckDuckGo\\b/gi, 'ArcArcGo').replace(/\\bDuckDuckGo's\\b/gi, "ArcArcGo's");
                  const selectors = [
                    'img[src*="data:image/svg+xml"]',
                    'img.header__logo',
                    'img.logo_homepage',
                    'img.js-logo-img',
                    'img[src*="/assets/logo"]',
                    'img[src*="/i/"]'
                  ];
                  const imgs = document.querySelectorAll(selectors.join(','));
                  imgs.forEach(img => {
                    if (img.src !== newLogoSrc) {
                      img.src = newLogoSrc;
                      img.alt = 'ArcArcGo Logo';
                      img.style.width = '189px';
                      img.style.height = '53px';
                      img.setAttribute('data-replaced', 'true');
                    }
                  });
                }
                const newLogoSrc = "https://i.postimg.cc/nc2W5CFR/image.png";
                window.addEventListener('load', replaceDuckTextAndLogo);
                window.addEventListener('DOMContentLoaded', replaceDuckTextAndLogo);
                setInterval(replaceDuckTextAndLogo, 500);
                const observer = new MutationObserver(replaceDuckTextAndLogo);
                observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
              </script>
            `;
            writer.write(encoder.encode(script));
            writer.close();
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 8192 || buffer.includes('</body>')) {
            writer.write(encoder.encode(rewriteChunk(buffer, targetOrigin, proxyBase, urlPatterns)));
            buffer = '';
          }
        }
      })();
  
      return new Response(readable, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    } catch (e) {
      return new Response(`Connection error: ${e.message}`, { status: 500 });
    }
  }
  
  function rewriteChunk(chunk, targetOrigin, proxyBase, urlPatterns) {
    let result = chunk;
    for (const { regex, attr } of urlPatterns) {
      result = result.replace(regex, (match, attribute, url) => {
        const targetUrl = url || attribute || match;
        if (typeof targetUrl !== 'string' || !targetUrl) return match;
        let newUrl = targetUrl;
        if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
          if (!targetUrl.startsWith(targetOrigin)) return match;
          newUrl = proxyBase + targetUrl.slice(targetOrigin.length);
        } else if (!targetUrl.startsWith('#') && !targetUrl.startsWith('data:') && !targetUrl.startsWith('javascript:')) {
          try {
            const resolvedUrl = new URL(targetUrl, targetOrigin);
            newUrl = proxyBase + resolvedUrl.pathname + (resolvedUrl.search || '');
          } catch {
            return match;
          }
        } else if (attribute && (attribute.startsWith('on') || attribute.includes('click'))) {
          return match.replace(/(location\.href|window\.location)\s*=\s*['"]([^'"]*)['"]/g, 
            (m, loc, u) => `${loc}="${proxyBase}${new URL(u, targetOrigin).pathname}${new URL(u, targetOrigin).search || ''}"`);
        }
        return attr === 0 ? newUrl : 
               (attr === 1 ? `${attribute}="${newUrl}"` : match.replace(targetUrl, newUrl));
      });
    }
    result = result.replace(/\bDuckDuckGo\b/gi, 'ArcArcGo');
    result = result.replace(/\bDuckDuckGo's\b/gi, "ArcArcGo's");
    result = result.replace(
      /<img[^>]*src\s*=\s*['"](data:image\/svg\+xml[^'"]*|https?:\/\/[^'"]*\/(assets\/logo|i\/)[^'"]*)['"][^>]*>/gi,
      '<img src="https://i.postimg.cc/nc2W5CFR/image.png" alt="ArcArcGo Logo" width="189" height="53">'
    );
    return result;
  }