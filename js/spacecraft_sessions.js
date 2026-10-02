(function(root) {
    function collect(storage) {
        const frames = [];
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (!key || !key.startsWith('aida-spacecraft-session:')) continue;
            const session = JSON.parse(storage.getItem(key));
            if (!session || !Array.isArray(session.matches) || !session.matches.length) continue;
            const frameId = key.slice('aida-spacecraft-session:'.length);
            const rows = session.matches.map(m => [m.image.x, m.image.y,
                m.catalog.raHours, m.catalog.decDeg, m.catalog.mag]);
            if (rows.some(r => r.slice(0,4).some(v => !Number.isFinite(v)))) {
                throw new Error('Invalid saved star coordinates for '+frameId);
            }
            frames.push({frameId, session, rows,
                names: session.matches.map(m => m.catalog.name || m.catalog.key || ''),
                observation: JSON.parse(storage.getItem('smile-calibration:'+frameId) || 'null')});
        }
        return frames.sort((a,b) => a.session.utc.localeCompare(b.session.utc));
    }
    const api = {collect};
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AidaSpacecraftSessions = api;
})(typeof window !== 'undefined' ? window : globalThis);
