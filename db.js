// db.js — stockage local-first via IndexedDB. Remplace window.storage du proto.
// Une seule "table" clé→valeur : clé = "log:YYYY-MM-DD", valeur = JSON de la séance.
const DB = (() => {
  const NAME = "carnet", STORE = "kv", VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const r = fn(store);
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error);
    }));
  }

  return {
    get: (key) => tx("readonly", (s) => s.get(key)).then((v) => (v == null ? null : { key, value: v })),
    set: (key, value) => tx("readwrite", (s) => s.put(value, key)),
    delete: (key) => tx("readwrite", (s) => s.delete(key)),
    list: (prefix = "") => tx("readonly", (s) => s.getAllKeys())
      .then((keys) => ({ keys: keys.filter((k) => String(k).startsWith(prefix)) })),
    // Demande au navigateur de ne pas vider le stockage (parade au risque "perte de données").
    persist: () => (navigator.storage && navigator.storage.persist ? navigator.storage.persist() : Promise.resolve(false)),
  };
})();
