// ===========================================================================
// POE Ninja Quantity Calculator - Content Script
// ===========================================================================
// Strategy: 
// 1. DIRECT API CALL (most reliable) - extract params from URL, call GetCharacter API
// 2. Fetch interceptor (fallback) - intercept poe.ninja's own API calls
// 3. React Fiber traversal (fallback)
// 4. PoB import code parsing (fallback)
// 5. DOM gem scanning (always runs as supplement)
// ===========================================================================

// --- Phase 1: Inject fetch interceptor (from web_accessible_resources) ---
try {
    const script = document.createElement('script');
    const runtime = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime : chrome.runtime;
    script.src = runtime.getURL('inject.js');
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
} catch (e) {
    console.warn('[POE-QC] Interceptor script injection failed:', e);
}

// HTML escape helper to prevent XSS and pass store linting
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// --- State ---
let characterItems = null;
let calculatedSources = null;
let uiInjected = false;

// --- Phase 2: Listen for intercepted data (fallback) ---
window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'POE_NINJA_CHAR_DATA') {
        const data = event.data.data;
        const sourceUrl = event.data.sourceUrl || '';
        
        console.log('[POE-QC] Intercepted fetch:', sourceUrl);
        
        if (data && Array.isArray(data.items) && data.items.length > 0) {
            console.log('[POE-QC] Intercepted character data with', data.items.length, 'items');
            if (!characterItems) {
                characterItems = data.items;
                tryInjectUI();
            }
        }
    }
});

// --- Phase 3: Direct API Call (PRIMARY strategy) ---

function parseCharacterURL() {
    const url = window.location.pathname;
    const match = url.match(/\/poe[12]\/builds\/([^/]+)\/character\/([^/]+)\/([^/?]+)/);
    if (match) {
        return { league: match[1], account: match[2], charName: decodeURIComponent(match[3]) };
    }
    return null;
}

function getSnapshotVersion(league) {
    try {
        const html = document.documentElement.innerHTML;
        // Pattern: find "url":[0,"<league>"] near "type":[0,"exp"] near "version":[0,"<version>"]
        // These appear in snapshotVersions in the Astro island props
        // Try to find a block that has all three: url=league, type=exp, version=X
        const blockRegex = /\{[^{}]*?"url":\[0,"([^"]+)"\][^{}]*?"type":\[0,"([^"]+)"\][^{}]*?"version":\[0,"([^"]+)"\][^{}]*?\}/g;
        let m;
        while ((m = blockRegex.exec(html)) !== null) {
            if (m[1] === league && m[2] === 'exp') {
                return m[3];
            }
        }
        
        // Try reversed order (type before url)
        const blockRegex2 = /\{[^{}]*?"type":\[0,"([^"]+)"\][^{}]*?"url":\[0,"([^"]+)"\][^{}]*?"version":\[0,"([^"]+)"\][^{}]*?\}/g;
        while ((m = blockRegex2.exec(html)) !== null) {
            if (m[2] === league && m[1] === 'exp') {
                return m[3];
            }
        }

        // Fallback: look for any version string near the league name  
        const simpleRegex = new RegExp(`"${league}"[^}]*?"version":\\[0,"([^"]+)"\\]`, 'g');
        const sm = simpleRegex.exec(html);
        if (sm) return sm[1];
        
    } catch(e) {
        console.log('[POE-QC] Error extracting version:', e);
    }
    return null;
}

async function fetchCharacterDataDirect() {
    const charInfo = parseCharacterURL();
    if (!charInfo) {
        console.log('[POE-QC] Not on a character page');
        return null;
    }
    
    console.log('[POE-QC] Character:', charInfo);
    
    const version = getSnapshotVersion(charInfo.league);
    console.log('[POE-QC] Snapshot version:', version);
    
    const urlPatterns = [];
    const acc = encodeURIComponent(charInfo.account);
    const name = encodeURIComponent(charInfo.charName);
    const league = charInfo.league;
    
    if (version) {
        urlPatterns.push(
            `https://poe.ninja/api/data/${version}/GetCharacter?account=${acc}&name=${name}&overview=${league}&type=exp&language=en`,
            `https://poe.ninja/api/data/${version}/GetCharacter?account=${acc}&name=${name}`,
            `/api/data/${version}/GetCharacter?account=${acc}&name=${name}&overview=${league}&type=exp&language=en`,
        );
    }
    
    urlPatterns.push(
        `/api/data/GetCharacter?account=${acc}&name=${name}&overview=${league}&type=exp&language=en`,
    );
    
    for (const apiUrl of urlPatterns) {
        try {
            console.log('[POE-QC] Trying:', apiUrl);
            const response = await fetch(apiUrl);
            if (!response.ok) {
                console.log('[POE-QC] Status:', response.status);
                continue;
            }
            const data = await response.json();
            if (data && Array.isArray(data.items) && data.items.length > 0) {
                console.log('[POE-QC] Direct API success!', data.items.length, 'items');
                return data.items;
            }
            if (data && data.character && Array.isArray(data.character.items)) {
                return data.character.items;
            }
            console.log('[POE-QC] No items in response. Keys:', Object.keys(data || {}));
        } catch(e) {
            console.log('[POE-QC] Error:', e.message);
        }
    }
    
    return null;
}

// --- Phase 4: React Fiber traversal ---
function findItemsFromReact() {
    try {
        const elements = document.querySelectorAll('[class*="equipment"], [class*="guardian"], [class*="item"], main, #main');
        for (const node of elements) {
            const key = Object.keys(node).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
            if (key) {
                let fiber = node[key];
                let depth = 0;
                while (fiber && depth < 30) {
                    if (fiber.memoizedProps) {
                        const items = extractItemsDeep(fiber.memoizedProps);
                        if (items && items.length > 3) return items;
                    }
                    if (fiber.memoizedState) {
                        let state = fiber.memoizedState;
                        while (state) {
                            if (state.memoizedState) {
                                const items = extractItemsDeep(state.memoizedState);
                                if (items && items.length > 3) return items;
                            }
                            state = state.next;
                        }
                    }
                    fiber = fiber.return;
                    depth++;
                }
            }
        }
    } catch(e) {
        console.log('[POE-QC] React Fiber error:', e);
    }
    return null;
}

function extractItemsDeep(obj, depth = 0) {
    if (depth > 5 || !obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj) && obj.length > 0 && isItemLike(obj[0])) return obj;
    for (const key of ['items', 'equipment', 'gear', 'equippedItems']) {
        if (Array.isArray(obj[key]) && obj[key].length > 0 && isItemLike(obj[key][0])) return obj[key];
    }
    for (const k in obj) {
        if (k === 'children' || k === '_owner' || k === 'element' || k === 'updater' || k === 'ref' || k.startsWith('__')) continue;
        if (obj[k] && typeof obj[k] === 'object') {
            const res = extractItemsDeep(obj[k], depth + 1);
            if (res) return res;
        }
    }
    return null;
}

function isItemLike(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return !!(obj.typeLine || (obj.explicitMods && Array.isArray(obj.explicitMods)) || obj.inventoryId || obj.baseType);
}

// --- Phase 5: PoB parsing ---
async function extractFromPoB() {
    const input = document.querySelector('input[aria-label="Import code for Path of Building"]');
    if (!input || !input.value) return null;
    
    try {
        let b64 = input.value.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) { b64 += '='; }
        
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        
        let text;
        try {
            const ds = new DecompressionStream('deflate');
            const response = await new Response(new Blob([bytes]).stream().pipeThrough(ds));
            text = await response.text();
        } catch(e) {
            const ds = new DecompressionStream('deflate-raw');
            const response = await new Response(new Blob([bytes]).stream().pipeThrough(ds));
            text = await response.text();
        }
        
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/xml');
        const items = doc.querySelectorAll('Item');
        
        let totalQuantity = 0;
        const sources = [];
        
        const slots = doc.querySelectorAll('Slot');
        const equippedItemIds = new Set();
        for (const slot of slots) {
            const itemId = slot.getAttribute('itemId');
            if (itemId && itemId !== "0") equippedItemIds.add(itemId);
        }
        
        for (const item of items) {
            const id = item.getAttribute('id');
            if (!equippedItemIds.has(id)) continue;
            
            const itemText = item.textContent;
            const regex = /(\d+)%\s*increased (?:quantity of items found|item quantity)/gi;
            let match;
            let itemQ = 0;
            while ((match = regex.exec(itemText)) !== null) {
                itemQ += parseInt(match[1], 10);
            }
            
            if (itemQ > 0) {
                const lines = itemText.split('\n').map(l => l.trim()).filter(l => l);
                let rarity = 'rare';
                const rarityLine = lines.find(l => l.startsWith('Rarity:'));
                if (rarityLine) {
                    const r = rarityLine.replace('Rarity:', '').trim().toLowerCase();
                    if (r.includes('unique')) rarity = 'unique';
                    else if (r.includes('rare')) rarity = 'rare';
                    else if (r.includes('magic')) rarity = 'magic';
                    else if (r.includes('gem')) rarity = 'gem';
                    else if (r.includes('normal')) rarity = 'normal';
                }
                
                const cleanLines = lines.filter(l => !l.includes(':') && l.length < 60 && !l.startsWith('{') && !l.startsWith('Implicits') && !l.startsWith('Quality') && !l.startsWith('Sockets') && !l.startsWith('LevelReq'));
                let displayName = 'Unknown Item';
                if (cleanLines.length >= 2 && (rarity === 'rare' || rarity === 'unique')) {
                    displayName = `${cleanLines[0]}, ${cleanLines[1]}`;
                } else if (cleanLines.length >= 1) {
                    displayName = cleanLines[0];
                }
                
                totalQuantity += itemQ;
                sources.push({ name: displayName, value: itemQ, rarity: rarity, tag: 'ITEM' });
            }
        }
        
        return { totalQuantity, sources };
    } catch (e) {
        console.log("[POE-QC] PoB parsing failed:", e);
        return null;
    }
}

// --- Phase 6: DOM gem quantity ---
function getGemQuantityFromDOM() {
    let maxGemQuant = 0;
    let gemNameStr = 'Item Quantity Support';
    
    const spans = document.querySelectorAll('span');
    for (const span of spans) {
        if (span.textContent.trim() === 'Item Quantity Support') {
            const parent = span.closest('.flex.items-center.rounded');
            if (parent) {
                const levelSpan = parent.querySelector('span[data-variant="subdued"]');
                if (levelSpan) {
                    const text = levelSpan.textContent.trim(); 
                    const parts = text.split('/');
                    const level = parseInt(parts[0], 10) || 20;
                    const quality = parts[1] ? parseInt(parts[1], 10) : 0;
                    
                    const baseQ = [0, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30, 31, 32, 34, 35, 36, 37, 38, 39];
                    let base = baseQ[level] || 35;
                    let qualQ = Math.floor(quality * 0.5);
                    
                    const totalQ = base + qualQ;
                    if (totalQ > maxGemQuant) {
                        maxGemQuant = totalQ;
                        gemNameStr = `Item Quantity Support (L${level}/Q${quality})`;
                    }
                }
            }
        }
    }
    return { value: maxGemQuant, name: gemNameStr, rarity: 'gem', tag: 'ITEM' };
}

// --- Item helpers & Quantity extraction ---
function cleanPoeText(text) {
    if (!text) return '';
    return text.replace(/<<set:[^>]*>>/g, '')
               .replace(/<[^>]*>/g, '')
               .trim();
}

function getItemRarity(item) {
    if (item.frameType === 3 || item.frameType === 9 || item.rarity === 3 || item.rarity === 'Unique' || item.rarity === 'unique') {
        return 'unique';
    }
    if (item.frameType === 2 || item.rarity === 2 || item.rarity === 'Rare' || item.rarity === 'rare') {
        return 'rare';
    }
    if (item.frameType === 1 || item.rarity === 1 || item.rarity === 'Magic' || item.rarity === 'magic') {
        return 'magic';
    }
    if (item.frameType === 4 || item.rarity === 4 || item.rarity === 'Gem' || item.rarity === 'gem') {
        return 'gem';
    }
    const cleanName = cleanPoeText(item.name);
    const cleanType = cleanPoeText(item.typeLine || item.baseType);
    if (cleanName && cleanType && cleanName !== cleanType) {
        return 'rare';
    }
    return 'normal';
}

function formatItemDisplayName(item) {
    const cleanName = cleanPoeText(item.name);
    const cleanType = cleanPoeText(item.typeLine || item.baseType);
    
    if (cleanName && cleanType && cleanName !== cleanType) {
        return `${cleanName}, ${cleanType}`;
    }
    return cleanName || cleanType || 'Unknown Item';
}

function extractQuantityFromItems(items) {
    let totalQuantity = 0;
    const sources = [];
    
    function getModText(mod) {
        if (typeof mod === 'string') return mod;
        if (mod && typeof mod === 'object' && typeof mod.text === 'string') return mod.text;
        if (mod && typeof mod === 'object' && typeof mod.value === 'string') return mod.value;
        return null;
    }
    
    function matchQuantity(text) {
        if (!text) return 0;
        const patterns = [
            /(\d+)%\s*increased Quantity of Items found/i,
            /(\d+)%\s*increased Item Quantity/i,
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) return parseInt(match[1], 10);
        }
        return 0;
    }
    
    function processItem(item) {
        let itemQ = 0;
        const modTypes = ['implicitMods', 'explicitMods', 'craftedMods', 'fracturedMods', 'enchantMods', 'utilityMods', 'runeMods', 'scourgeMods', 'crucibleMods'];
        
        for (const modType of modTypes) {
            if (item[modType] && Array.isArray(item[modType])) {
                for (const mod of item[modType]) {
                    const text = getModText(mod);
                    const q = matchQuantity(text);
                    if (q > 0) {
                        console.log(`[POE-QC] +${q}% IQ in ${modType} of "${item.name || item.typeLine}": "${text}"`);
                        itemQ += q;
                    }
                }
            }
        }
        
        if (itemQ > 0) {
            const displayName = formatItemDisplayName(item);
            const rarity = getItemRarity(item);
            totalQuantity += itemQ;
            sources.push({ name: displayName, value: itemQ, rarity: rarity, tag: 'ITEM' });
        }
        
        if (item.socketedItems && Array.isArray(item.socketedItems)) {
            for (const socketed of item.socketedItems) {
                processItem(socketed);
            }
        }
    }
    
    for (const item of items) {
        processItem(item);
    }
    
    return { totalQuantity, sources };
}

// --- Main orchestration ---
async function calculateAndInject(dl) {
    let totalQuantity = 0;
    let sources = [];
    
    // 1. Use intercepted items if available
    if (characterItems && characterItems.length > 0) {
        console.log('[POE-QC] Using intercepted items:', characterItems.length);
        const result = extractQuantityFromItems(characterItems);
        totalQuantity = result.totalQuantity;
        sources = result.sources;
    }
    
    // 2. Direct API call
    if (totalQuantity === 0) {
        console.log('[POE-QC] Trying direct API...');
        const apiItems = await fetchCharacterDataDirect();
        if (apiItems && apiItems.length > 0) {
            characterItems = apiItems;
            const result = extractQuantityFromItems(apiItems);
            totalQuantity = result.totalQuantity;
            sources = result.sources;
        }
    }
    
    // 3. React Fiber
    if (totalQuantity === 0 && !characterItems) {
        console.log('[POE-QC] Trying React Fiber...');
        const reactItems = findItemsFromReact();
        if (reactItems && reactItems.length > 0) {
            characterItems = reactItems;
            const result = extractQuantityFromItems(reactItems);
            totalQuantity = result.totalQuantity;
            sources = result.sources;
        }
    }
    
    // 4. PoB
    if (totalQuantity === 0) {
        console.log('[POE-QC] Trying PoB...');
        const pobData = await extractFromPoB();
        if (pobData && pobData.totalQuantity > 0) {
            totalQuantity = pobData.totalQuantity;
            sources = pobData.sources;
        }
    }
    
    // Always: gem from DOM
    const gemData = getGemQuantityFromDOM();
    if (gemData.value > 0) {
        const alreadyCounted = sources.find(s => s.name.includes('Item Quantity Support'));
        if (!alreadyCounted) {
            totalQuantity += gemData.value;
            sources.push({ name: gemData.name, value: gemData.value, rarity: 'gem', tag: 'ITEM' });
        }
    }
    
    if (totalQuantity === 0 && sources.length === 0) {
        console.log('[POE-QC] No quantity sources found');
        return;
    }
    
    console.log(`[POE-QC] Total IQ: ${totalQuantity}% from ${sources.length} sources`);
    calculatedSources = { totalQuantity, sources };
    
    // --- Build UI ---
    const div = document.createElement('div');
    div.id = 'poe-ninja-quant-calc';
    div.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr;';

    const dt = document.createElement('dt');
    dt.textContent = 'Item Quantity';

    const dd = document.createElement('dd');
    dd.className = 'quant-calc-container';
    dd.style.cssText = 'text-align: right; color: var(--color-coolgrey-100, #f1f5f9); cursor: help; position: relative; font-variant-numeric: tabular-nums;';
    dd.textContent = totalQuantity + '%';

    const tooltip = document.createElement('div');
    tooltip.className = 'quant-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('data-tooltip-content', 'true');
    
    const card = document.createElement('div');
    card.className = 'relative bg-coolgrey-950 border border-coolgrey-700 rounded-sm pt-5 px-4 pb-3 quant-tooltip-card';

    // Pin container
    const pinContainer = document.createElement('div');
    pinContainer.className = 'absolute top-0 right-0 z-10';
    pinContainer.style.pointerEvents = 'auto';

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'quant-pin-btn w-4 h-4 grid place-items-center border-b border-l transition-colors cursor-pointer rounded-bl rounded-tr border-coolgrey-700 bg-coolgrey-950 text-coolgrey-400 hover:bg-coolgrey-600 hover:text-white';
    pinBtn.setAttribute('aria-label', 'Pin tooltip');
    pinBtn.title = 'Pin breakdown (Alt)';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'w-2.5 h-2.5');
    svg.setAttribute('viewBox', '-3 -2.5 24 24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm7.374 12.268l-5.656 5.657A1 1 0 1 1 .303 16.51l5.657-5.656L1.718 6.61A6.992 6.992 0 0 1 7.9 4.67L11.617.954a2 2 0 0 1 2.828 0l2.829 2.828a2 2 0 0 1 0 2.829l-3.716 3.716a6.992 6.992 0 0 1-1.941 6.183l-4.243-4.242z');
    svg.appendChild(path);
    pinBtn.appendChild(svg);
    pinContainer.appendChild(pinBtn);
    card.appendChild(pinContainer);

    // Content box
    const contentBox = document.createElement('div');
    contentBox.className = 'flex flex-col gap-2 min-w-[340px] max-w-[460px]';

    // Header
    const header = document.createElement('div');
    header.className = 'flex justify-between items-center pr-6 font-semibold text-white text-[15px] leading-tight';
    const headerTitle = document.createElement('span');
    headerTitle.textContent = 'Item Quantity';
    const headerVal = document.createElement('span');
    headerVal.className = 'whitespace-nowrap font-semibold';
    headerVal.textContent = totalQuantity + '%';
    header.appendChild(headerTitle);
    header.appendChild(headerVal);
    contentBox.appendChild(header);

    // Badge
    const badge = document.createElement('div');
    badge.className = 'bg-emerald-900/60 rounded-xs flex items-center justify-between px-3 py-1.5 font-semibold text-xs leading-none text-emerald-400 my-0.5';
    const badgeLabel = document.createElement('span');
    badgeLabel.textContent = 'Increased';
    const badgeVal = document.createElement('span');
    badgeVal.className = 'whitespace-nowrap';
    badgeVal.textContent = `+${totalQuantity}%`;
    badge.appendChild(badgeLabel);
    badge.appendChild(badgeVal);
    contentBox.appendChild(badge);

    // Grid rows
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-[1fr_auto_auto] items-center gap-x-2.5 gap-y-1 text-xs pt-1';

    for (const src of sources) {
        const nameSpan = document.createElement('span');
        nameSpan.className = 'truncate text-left font-normal';
        nameSpan.textContent = src.name;
        nameSpan.title = src.name;

        if (src.rarity === 'unique') {
            nameSpan.style.color = 'hsla(var(--item-unique, 24, 65%, 42%, 1))';
        } else if (src.rarity === 'rare') {
            nameSpan.style.color = 'hsla(var(--item-rare, 54, 100%, 73%, 1))';
        } else if (src.rarity === 'magic') {
            nameSpan.style.color = 'hsla(var(--item-magic, 218, 97%, 75%, 1))';
        } else if (src.rarity === 'gem') {
            nameSpan.style.color = 'hsla(var(--item-gem, 175, 71%, 37%, 1))';
        } else {
            nameSpan.style.color = 'var(--color-coolgrey-200, #e2e8f0)';
        }

        const tagSpan = document.createElement('span');
        tagSpan.className = 'text-coolgrey-400 text-[0.8em] font-semibold uppercase tracking-wider text-right pl-2';
        tagSpan.textContent = src.tag || 'ITEM';

        const valSpan = document.createElement('span');
        valSpan.className = 'text-right whitespace-nowrap text-white font-medium pl-2';
        valSpan.textContent = src.value >= 0 ? `+${src.value}%` : `${src.value}%`;

        grid.appendChild(nameSpan);
        grid.appendChild(tagSpan);
        grid.appendChild(valSpan);
    }

    contentBox.appendChild(grid);
    card.appendChild(contentBox);
    tooltip.appendChild(card);
    dd.appendChild(tooltip);
    div.appendChild(dt);
    div.appendChild(dd);

    // --- Pin & interaction logic ---
    let isPinned = false;
    let isHovered = false;

    function setPin(pinned) {
        isPinned = pinned;
        if (isPinned) {
            tooltip.classList.add('is-pinned');
            if (pinBtn) {
                pinBtn.classList.remove('text-coolgrey-400');
                pinBtn.classList.add('text-emerald-500');
                pinBtn.title = 'Unpin (Alt or Click)';
            }
        } else {
            tooltip.classList.remove('is-pinned');
            if (pinBtn) {
                pinBtn.classList.remove('text-emerald-500');
                pinBtn.classList.add('text-coolgrey-400');
                pinBtn.title = 'Pin (Alt or Click)';
            }
        }
    }

    if (pinBtn) {
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            setPin(!isPinned);
        });
    }

    dd.addEventListener('mouseenter', () => {
        isHovered = true;
    });

    dd.addEventListener('mouseleave', () => {
        isHovered = false;
    });

    const onKeyDown = (e) => {
        if (e.key === 'Alt') {
            if (isHovered || isPinned) {
                e.preventDefault();
                setPin(!isPinned);
            }
        } else if (e.key === 'Escape' && isPinned) {
            setPin(false);
        }
    };

    const onDocClick = (e) => {
        if (isPinned && !dd.contains(e.target)) {
            setPin(false);
        }
    };

    if (window._poeQuantCleanup) {
        window._poeQuantCleanup();
    }
    window._poeQuantCleanup = () => {
        window.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('click', onDocClick);
    };

    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onDocClick);

    let inserted = false;
    const rows = dl.querySelectorAll('div');
    for (let row of rows) {
        const term = row.querySelector('dt');
        if (term && term.textContent.includes('Item Rarity')) {
            row.after(div);
            inserted = true;
            break;
        }
    }
    if (!inserted) dl.appendChild(div);
    
    uiInjected = true;
}

// --- UI injection trigger ---
async function tryInjectUI() {
    if (uiInjected) return;
    
    const headings = Array.from(document.querySelectorAll('h3'));
    const charHeading = headings.find(h => h.textContent.trim() === 'Character');
    if (!charHeading) return;

    const dl = charHeading.nextElementSibling;
    if (!dl || dl.tagName !== 'DL') return;

    await calculateAndInject(dl);
}

// Periodic check (page is client-side rendered, so DOM builds over time)
setInterval(tryInjectUI, 2000);

// Watch for SPA navigation
let lastUrl = window.location.href;
new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        characterItems = null;
        calculatedSources = null;
        uiInjected = false;
        if (window._poeQuantCleanup) {
            window._poeQuantCleanup();
            window._poeQuantCleanup = null;
        }
        const el = document.getElementById('poe-ninja-quant-calc');
        if (el) el.remove();
        console.log('[POE-QC] URL changed, resetting...');
    }
}).observe(document.body || document.documentElement, { childList: true, subtree: true });

