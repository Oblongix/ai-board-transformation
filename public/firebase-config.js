(function () {
  const firebaseConfig = window.__FIREBASE_CONFIG__ || {
    apiKey: "AIzaSyC9RBe-xM2kbUkKYm743G30ny8c6R6fwsM",
    authDomain: "ceoaisimulate.firebaseapp.com",
    projectId: "ceoaisimulate",
    storageBucket: "ceoaisimulate.firebasestorage.app",
    messagingSenderId: "84951833489",
    appId: "1:84951833489:web:6c7211dc6be8a0135fd830",
  };

  const isPlaceholder =
    typeof firebaseConfig.apiKey === "string" && firebaseConfig.apiKey.startsWith("YOUR_");
  const host = location.hostname || "";
  const isLocalHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".local") ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    host.startsWith("172.");
  const forceReal = window.FORCE_REAL_FIREBASE === true || window.FORCE_REAL_FIREBASE === "1";

  function setupMock() {
    const store = {
      users: {},
      simulationSessions: {},
    };
    const listeners = [];
    let currentUser = null;

    function makeId(prefix) {
      return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
    }

    const FieldValue = {
      serverTimestamp() {
        return { __ts: new Date().toISOString() };
      },
      arrayUnion(...items) {
        return { __arrayUnion: items };
      },
    };

    function normalize(v) {
      if (v && v.__ts) return v.__ts;
      return v;
    }

    function applyUpdate(target, data) {
      for (const [k, v] of Object.entries(data)) {
        const val = normalize(v);
        if (val && val.__arrayUnion) {
          const curr = Array.isArray(target[k]) ? target[k] : [];
          target[k] = Array.from(new Set([...curr, ...val.__arrayUnion]));
        } else {
          target[k] = val;
        }
      }
    }

    const auth = {
      get currentUser() {
        return currentUser;
      },
      onAuthStateChanged(cb) {
        listeners.push(cb);
        setTimeout(() => cb(currentUser), 0);
      },
      async signInWithEmailAndPassword(email, password) {
        const user = Object.values(store.users).find((u) => u.email === email && u.password === password);
        if (!user) throw new Error("Invalid credentials (mock mode)");
        currentUser = { uid: user.uid, email: user.email, displayName: user.name };
        listeners.forEach((cb) => cb(currentUser));
        return { user: currentUser };
      },
      async createUserWithEmailAndPassword(email, password) {
        if (Object.values(store.users).some((u) => u.email === email)) {
          throw new Error("Email already exists (mock mode)");
        }
        const uid = makeId("user");
        store.users[uid] = { uid, email, password, name: email.split("@")[0] };
        currentUser = { uid, email, displayName: store.users[uid].name };
        listeners.forEach((cb) => cb(currentUser));
        return {
          user: {
            ...currentUser,
            async updateProfile({ displayName }) {
              store.users[uid].name = displayName;
              currentUser.displayName = displayName;
            },
          },
        };
      },
      async signOut() {
        currentUser = null;
        listeners.forEach((cb) => cb(null));
      },
      async sendPasswordResetEmail(email) {
        const found = Object.values(store.users).some((u) => u.email === email);
        if (!found) throw new Error("No account found (mock mode)");
      },
    };

    function collection(name) {
      if (!store[name]) store[name] = {};
      return {
        doc(id) {
          return {
            async set(data, opts) {
              const current = store[name][id] || {};
              const input = { ...data };
              Object.keys(input).forEach((k) => {
                input[k] = normalize(input[k]);
              });
              store[name][id] = opts && opts.merge ? { ...current, ...input } : input;
            },
            async update(data) {
              const current = store[name][id] || {};
              applyUpdate(current, data);
              store[name][id] = current;
            },
            async get() {
              const data = store[name][id];
              return { exists: !!data, id, data: () => data };
            },
          };
        },
        async add(data) {
          const id = makeId("sess");
          const payload = { ...data };
          Object.keys(payload).forEach((k) => {
            payload[k] = normalize(payload[k]);
          });
          store[name][id] = payload;
          return { id };
        },
        where(field, op, value) {
          const q = {
            orderBy(orderField, direction) {
              this.orderField = orderField;
              this.direction = String(direction || "asc").toLowerCase();
              return this;
            },
            async get() {
              let docs = Object.entries(store[name])
                .map(([id, data]) => ({ id, data }))
                .filter((item) => (op === "==" ? item.data[field] === value : true));
              if (this.orderField) {
                docs.sort((a, b) => {
                  const av = a.data[this.orderField] || "";
                  const bv = b.data[this.orderField] || "";
                  if (av === bv) return 0;
                  if (this.direction === "desc") return av > bv ? -1 : 1;
                  return av > bv ? 1 : -1;
                });
              }
              return {
                docs: docs.map((item) => ({ id: item.id, data: () => item.data })),
              };
            },
          };
          return q;
        },
      };
    }

    const db = { collection, _store: store };
    window.firebaseServices = {
      auth,
      db,
      firebase: { firestore: { FieldValue } },
      usingMock: true,
      config: firebaseConfig,
    };
  }

  if ((isLocalHost && !forceReal) || isPlaceholder) {
    setupMock();
    return;
  }

  if (typeof window.firebase === "undefined") {
    console.error("Firebase SDK was not loaded.");
    window.firebaseServices = { auth: null, db: null, firebase: null, usingMock: false };
    return;
  }

  try {
    if (!window.firebase.apps || window.firebase.apps.length === 0) {
      window.firebase.initializeApp(firebaseConfig);
    }
    const auth = window.firebase.auth();
    const db = window.firebase.firestore();
    window.firebaseServices = {
      auth,
      db,
      firebase: window.firebase,
      usingMock: false,
      config: firebaseConfig,
    };
  } catch (error) {
    console.error("Firebase initialization failed:", error);
    window.firebaseServices = { auth: null, db: null, firebase: null, usingMock: false };
  }
})();
