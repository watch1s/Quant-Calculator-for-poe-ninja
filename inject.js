(function() {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        try {
            const clone = response.clone();
            clone.json().then(data => {
                if (data) {
                    window.postMessage({ type: 'POE_NINJA_CHAR_DATA', data: data }, '*');
                }
            }).catch(e => {});
        } catch(e) {}
        return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._url = url;
        return originalOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            try {
                if (this.responseType === '' || this.responseType === 'text') {
                    const data = JSON.parse(this.responseText);
                    if (data) {
                        window.postMessage({ type: 'POE_NINJA_CHAR_DATA', data: data }, '*');
                    }
                } else if (this.responseType === 'json') {
                    if (this.response) {
                        window.postMessage({ type: 'POE_NINJA_CHAR_DATA', data: this.response }, '*');
                    }
                }
            } catch(e) {}
        });
        return originalSend.apply(this, args);
    };
})();
