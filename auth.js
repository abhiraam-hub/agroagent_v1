// auth.js — AgroAgent Authentication System
// Migrated from localStorage to Firebase Auth + Firestore
// Maintains full backward-compatible API so register.js / login.js need minimal changes

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  getDocs,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

// ─────────────────────────────────────────────
// Role constants — single source of truth
// ─────────────────────────────────────────────
export const ROLES = {
  FARMER: "farmer",
  BUYER: "buyer",
  EQUIPMENT: "equipment",
  GROCERY: "grocery",
  EXPERT: "expert",
  ADMIN: "admin",
};

// Pages each role is allowed to access (filename without path)
const ROLE_HOME = {
  farmer: "farmer.html",
  buyer: "buyer.html",
  equipment: "equipment.html",
  grocery: "grocery.html",
  expert: "expert.html",
  admin: "admin.html",
};

// ─────────────────────────────────────────────
// Firebase initialisation (config fetched from Flask)
// ─────────────────────────────────────────────
let _app, _auth, _db;
let _firebaseAvailable = null;

async function getFirebaseInstances() {
  if (_firebaseAvailable === false) return null;
  if (_auth && _db) return { auth: _auth, db: _db };

  try {
    const res = await fetch('/api/firebase-config');
    if (!res.ok) throw new Error('Failed to fetch Firebase config');
    
    const config = await res.json();
    if (!config || !config.apiKey || typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
      _firebaseAvailable = false;
      return null;
    }

    _app = initializeApp(config);
    _auth = getAuth(_app);
    _db = getFirestore(_app);
    window._agriDb = _db;
    _firebaseAvailable = true;
    return { auth: _auth, db: _db };
  } catch (err) {
    console.warn("Firebase not configured or unavailable, using backend API:", err);
    _firebaseAvailable = false;
    return null;
  }
}

class AuthManager {
  constructor() {
    // currentUser is populated after observeAuth resolves
    this.currentUser = null;
    this._ready = false;

    getFirebaseInstances().catch(console.error);
  }

  // ── Register ──────────────────────────────
  async register({ role, fullname, email, password }) {
    const validation = this._validateRegistrationData({ role, fullname, email, password });
    if (!validation.valid) {
      return { success: false, message: validation.message };
    }

    const pwCheck = this._validatePassword(password);
    if (!pwCheck.valid) return { success: false, message: pwCheck.message };

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedFullname = fullname.trim();
    const normalizedRole = role.trim().toLowerCase();

    // 1. Try Firebase if available and configured
    try {
      const fb = await getFirebaseInstances();
      if (fb && fb.auth && fb.db) {
        const cred = await createUserWithEmailAndPassword(fb.auth, normalizedEmail, password);

        // Store profile + role in Firestore
        await setDoc(doc(fb.db, "users", cred.user.uid), {
          fullname: normalizedFullname,
          email: normalizedEmail,
          role: normalizedRole,
          createdAt: serverTimestamp(),
          isActive: true,
          isBanned: false,
        });

        const userData = { id: cred.user.uid, fullname: normalizedFullname, email: normalizedEmail, role: normalizedRole };
        this._setSession(userData);

        return {
          success: true,
          message: "Account created successfully!",
          user: userData,
        };
      }
    } catch (fbErr) {
      console.warn("Firebase registration skipped or failed:", fbErr);
      if (fbErr.code && fbErr.code.startsWith("auth/")) {
        return { success: false, message: this._friendlyError(fbErr.code) };
      }
    }

    // 2. Fallback to Flask Backend API Registration
    try {
      const usernameBase = normalizedEmail.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '') || 'user';
      const username = usernameBase.length < 3 ? (usernameBase + '123') : usernameBase.substring(0, 30);

      const resp = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          full_name: normalizedFullname,
          fullname: normalizedFullname,
          email: normalizedEmail,
          password,
          role: normalizedRole
        })
      });

      const resData = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return {
          success: false,
          message: resData.message || "Registration failed. Please check your details and try again."
        };
      }

      const userObj = resData.user || {};
      const userData = {
        id: userObj.id || Date.now(),
        fullname: userObj.full_name || normalizedFullname,
        email: userObj.email || normalizedEmail,
        role: userObj.role || normalizedRole
      };

      this._setSession(userData);

      return {
        success: true,
        message: "Account created successfully!",
        user: userData,
      };
    } catch (apiErr) {
      console.error("Backend registration error:", apiErr);
      return {
        success: false,
        message: "Unable to connect to server. Please try again."
      };
    }
  }

  // ── Login ─────────────────────────────────
  async login(email, password) {
    const validation = this._validateLoginData(email, password);
    if (!validation.valid) {
      return { success: false, message: validation.message };
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 1. Try Firebase if available and configured
    try {
      const fb = await getFirebaseInstances();
      if (fb && fb.auth && fb.db) {
        const cred = await signInWithEmailAndPassword(fb.auth, normalizedEmail, password);

        // Fetch role and profile from Firestore
        const snap = await getDoc(doc(fb.db, "users", cred.user.uid));
        if (!snap.exists()) {
          return {
            success: false,
            message: "User profile not found. Please re-register.",
          };
        }

        const data = snap.data();

        if (data.isBanned) {
          return {
            success: false,
            message: "Your account has been suspended. Contact support.",
          };
        }

        if (!data.isActive) {
          return {
            success: false,
            message: "Account is deactivated. Contact support.",
          };
        }

        // Update lastLogin in Firestore
        await updateDoc(doc(fb.db, "users", cred.user.uid), {
          lastLogin: serverTimestamp(),
        });

        const userData = {
          id: cred.user.uid,
          fullname: data.fullname,
          email: data.email,
          role: data.role,
        };
        this._setSession(userData);

        return { success: true, message: "Login successful!", user: userData };
      }
    } catch (fbErr) {
      console.warn("Firebase login failed:", fbErr);
      if (fbErr.code && (fbErr.code === "auth/wrong-password" || fbErr.code === "auth/invalid-credential" || fbErr.code === "auth/user-not-found")) {
        return { success: false, message: this._friendlyError(fbErr.code) };
      }
    }

    // 2. Fallback to Flask Backend API Login
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: normalizedEmail,
          password: password
        })
      });

      const resData = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return {
          success: false,
          message: resData.message || "Invalid email or password."
        };
      }

      const userObj = resData.user || {};
      const userData = {
        id: userObj.id || Date.now(),
        fullname: userObj.full_name || normalizedEmail.split('@')[0],
        email: userObj.email || normalizedEmail,
        role: userObj.role || "farmer"
      };

      if (resData.access_token) {
        sessionStorage.setItem("agroagent_access_token", resData.access_token);
      }
      this._setSession(userData);

      return { success: true, message: "Login successful!", user: userData };
    } catch (apiErr) {
      console.error("Backend login error:", apiErr);
      return {
        success: false,
        message: "Unable to connect to server. Please try again."
      };
    }
  }

  // ── Logout ────────────────────────────────
  async logout() {
    try {
      const fb = await getFirebaseInstances();
      if (fb && fb.auth) {
        await signOut(fb.auth);
      }
    } catch (_) {}
    sessionStorage.removeItem("agroagent_session");
    sessionStorage.removeItem("agroagent_access_token");
    this.currentUser = null;
    window.location.href = "login.html";
    return { success: true };
  }
      this.currentUser = null;
      window.location.href = "login.html";
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // ── Check login state ─────────────────────
  isLoggedIn() {
    return this.currentUser !== null;
  }

  // ── Get current user ──────────────────────
  getCurrentUser() {
    if (this.currentUser) return this.currentUser;
    try {
      const s = sessionStorage.getItem("agroagent_session");
      if (s) {
        this.currentUser = JSON.parse(s);
        return this.currentUser;
      }
    } catch (_) {}
    return null;
  }

  // ── Role helpers ──────────────────────────
  getHomePageForRole(role) {
    return ROLE_HOME[role] || "main.html";
  }

  // ── Admin: get all users ──────────────────
  async getAllUsers() {
    const { db } = await getFirebaseInstances();
    const snap = await getDocs(collection(db, "users"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // ── Admin: ban / unban ────────────────────
  async setBanned(uid, isBanned) {
    const { db } = await getFirebaseInstances();
    await updateDoc(doc(db, "users", uid), { isBanned });
    return { success: true };
  }

  // ── Admin: change role ────────────────────
  async setRole(uid, newRole) {
    const { db } = await getFirebaseInstances();
    await updateDoc(doc(db, "users", uid), { role: newRole });
    return { success: true };
  }

  // ─────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────
  _setSession(user) {
    this.currentUser = user;
    sessionStorage.setItem("agroagent_session", JSON.stringify(user));
  }

  _validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  _validatePassword(password) {
    if (password.length < 8)
      return {
        valid: false,
        message: "Password must be at least 8 characters long",
      };
    if (!/[a-z]/.test(password))
      return {
        valid: false,
        message: "Password must contain at least one lowercase letter",
      };
    if (!/[A-Z]/.test(password))
      return {
        valid: false,
        message: "Password must contain at least one uppercase letter",
      };
    if (!/\d/.test(password))
      return {
        valid: false,
        message: "Password must contain at least one number",
      };
    return { valid: true };
  }

  _validateRegistrationData({ role, fullname, email, password }) {
    if (!role || !fullname || !email || !password) {
      return { valid: false, message: "All fields are required" };
    }

    const normalizedRole = role.trim().toLowerCase();
    const allowedRoles = ["buyer", "farmer", "equipment", "grocery", "expert"];

    if (!allowedRoles.includes(normalizedRole)) {
      return { valid: false, message: "Please select a valid role" };
    }

    if (!/^[a-zA-Z\s.'-]+$/.test(fullname.trim())) {
      return { valid: false, message: "Full name can only contain letters and spaces" };
    }

    if (!this._validateEmail(email)) {
      return { valid: false, message: "Please use a valid email address" };
    }

    return { valid: true };
  }

  _validateLoginData(email, password) {
    if (!email || !password) {
      return { valid: false, message: "Email and password are required" };
    }

    if (!this._validateEmail(email)) {
      return { valid: false, message: "Please enter a valid email address" };
    }

    return { valid: true };
  }

  _friendlyError(code) {
    const map = {
      "auth/email-already-in-use": "An account with this email already exists.",
      "auth/invalid-email": "Please enter a valid email address.",
      "auth/weak-password": "Password must be at least 6 characters.",
      "auth/user-not-found": "Invalid email or password.",
      "auth/wrong-password": "Invalid email or password.",
      "auth/too-many-requests": "Too many attempts. Please try again later.",
      "auth/network-request-failed": "Network error. Check your connection.",
      "auth/invalid-credential": "Invalid email or password.",
    };
    return map[code] || "Something went wrong. Please try again.";
  }

  // ── UI helper (kept from old auth.js) ─────
  updateAuthUI() {
    const user = this.getCurrentUser();
    const isLoggedIn = !!user;

    const loginBtn = document.querySelector(".login-btn-desktop");
    const registerBtn = document.querySelector(".register-btn-desktop");
    const logoutBtn = document.querySelector(".logout-button");
    const mobileLogin = document.querySelector(
      'a[href="login.html"].mobile-link',
    );
    const mobileReg = document.querySelector(
      'a[href="register.html"].mobile-link',
    );

    if (isLoggedIn) {
      if (loginBtn) loginBtn.style.display = "none";
      if (registerBtn) registerBtn.style.display = "none";
      if (logoutBtn) {
        logoutBtn.style.display = "inline-flex";
        logoutBtn.onclick = (e) => {
          e.preventDefault();
          this.logout();
        };
      }
      if (mobileLogin) mobileLogin.style.display = "none";
      if (mobileReg) mobileReg.style.display = "none";
    } else {
      if (loginBtn) loginBtn.style.display = "inline-flex";
      if (registerBtn) registerBtn.style.display = "inline-flex";
      if (logoutBtn) logoutBtn.style.display = "none";
      if (mobileLogin) mobileLogin.style.display = "flex";
      if (mobileReg) mobileReg.style.display = "flex";
    }
  }
}

// ─────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────
window.authManager = new AuthManager();

// ─────────────────────────────────────────────
// Page guards — same function names as before
// ─────────────────────────────────────────────

/**
 * requireAuth([allowedRoles])
 * Call on any protected page.
 * Optionally pass roles that are allowed, e.g. requireAuth(["admin"])
 */
window.requireAuth = function (allowedRoles = []) {
  const user = window.authManager.getCurrentUser();
  if (!user) {
    showAuthMessage("Please log in to access this page.", "error");
    setTimeout(() => {
      window.location.href = "login.html";
    }, 1500);
    return false;
  }
  if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
    showAuthMessage("You don't have permission to view this page.", "error");
    setTimeout(() => {
      window.location.href = "unauthorized.html";
    }, 1500);
    return false;
  }
  return true;
};

/** Redirect already-logged-in users away from login/register pages */
window.redirectIfLoggedIn = function () {
  const user = window.authManager.getCurrentUser();
  if (user) {
    window.location.href = window.authManager.getHomePageForRole(user.role);
  }
};

// ─────────────────────────────────────────────
// showAuthMessage — kept exactly from old auth.js
// ─────────────────────────────────────────────
window.showAuthMessage = function (message, type = "info") {
  const existing = document.querySelector(".auth-message");
  if (existing) existing.remove();

  const div = document.createElement("div");
  div.className = `auth-message auth-message-${type}`;
  div.innerHTML = `
    <div class="auth-message-content">
      <i class="fas fa-${type === "success" ? "check-circle" : type === "error" ? "exclamation-circle" : "info-circle"}"></i>
      <span>${message}</span>
    </div>`;

  div.style.cssText = `
    position:fixed; top:20px; right:20px; z-index:10000;
    padding:15px 20px; border-radius:8px; color:white;
    font-weight:500; box-shadow:0 4px 12px rgba(0,0,0,.15);
    animation:slideInRight .3s ease-out; max-width:400px;`;

  const colors = {
    success: "linear-gradient(135deg,#4caf50,#45a049)",
    error: "linear-gradient(135deg,#f44336,#e53935)",
    info: "linear-gradient(135deg,#2196f3,#1976d2)",
  };
  div.style.background = colors[type] || colors.info;
  document.body.appendChild(div);

  setTimeout(() => {
    if (div.parentNode) {
      div.style.animation = "slideOutRight .3s ease-out";
      setTimeout(() => div.remove(), 300);
    }
  }, 5000);
};

// CSS animations (same as before)
const s = document.createElement("style");
s.textContent = `
  @keyframes slideInRight  { from{opacity:0;transform:translateX(100%)} to{opacity:1;transform:translateX(0)} }
  @keyframes slideOutRight { from{opacity:1;transform:translateX(0)}    to{opacity:0;transform:translateX(100%)} }
  .auth-message-content { display:flex; align-items:center; gap:10px; }
  .auth-message-content i { font-size:1.2rem; }
`;
document.head.appendChild(s);

// Run UI update on every page load
document.addEventListener("DOMContentLoaded", () => {
  window.authManager.updateAuthUI();
});
