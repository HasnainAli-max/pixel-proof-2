// pages/signup.js
"use client";

import { useEffect, useState } from "react";
import { createUserWithEmailAndPassword, updateProfile, onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase/config";
import Link from "next/link";
import { useRouter } from "next/router";
import { Toaster, toast } from "sonner";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";

const MAX_IMAGE_MB = 5;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];

const CustomSignUp = () => {
  const router = useRouter();
  const planFromQuery = typeof router?.query?.plan === "string" ? router.query.plan : null;

  const [firstName, setFirstName] = useState("");
  const [lastName,  setLastName]  = useState("");
  const [email,     setEmail]     = useState("");
  const [password,  setPassword]  = useState("");
  const [loading,   setLoading]   = useState(false);

  const [avatarFile, setAvatarFile] = useState(null);
  const [selectedImageName, setSelectedImageName] = useState("");

  // If already signed in and there's a plan → send to checkout immediately
  // Otherwise if already signed in → go to utility
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) return;
      if (planFromQuery) {
        router.replace(`/billing/checkout?plan=${encodeURIComponent(planFromQuery)}`);
      } else {
        router.replace("/utility");
      }
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planFromQuery]);

  const validate = () => {
    if (!firstName.trim()) return "First name is required.";
    if (!lastName.trim())  return "Last name is required.";
    if (!email.trim())     return "Email is required.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email.";
    if (password.length < 6) return "Password must be at least 6 characters.";
    if (avatarFile) {
      if (!ACCEPTED.includes(avatarFile.type)) return "Please upload PNG, JPG, or WEBP image.";
      if (avatarFile.size > MAX_IMAGE_MB * 1024 * 1024) return `Image must be <= ${MAX_IMAGE_MB}MB.`;
    }
    return null;
  };

  const fbError = (e) => {
    const code = e?.code || "";
    switch (code) {
      case "auth/email-already-in-use":  return "That email is already registered.";
      case "auth/invalid-email":         return "Enter a valid email.";
      case "auth/weak-password":         return "Password should be at least 6 characters.";
      case "auth/network-request-failed":return "Network error. Check your connection.";
      case "permission-denied":          return "Permission denied by Firestore rules.";
      default:                           return e?.message || "Sign up failed";
    }
  };

  const upsertUserDoc = async (user, { firstName, lastName, photoURL, avatarPath }) => {
    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);

    const base = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || `${firstName} ${lastName}`.trim(),
      firstName,
      lastName,
      photoURL: photoURL || null,
      avatarPath: avatarPath || null, // supabase/storage path (if you use it)
      provider: user.providerData?.[0]?.providerId || "password",
      role: "user",
      updatedAt: serverTimestamp(),
    };
    if (!snap.exists()) base.createdAt = serverTimestamp();

    await setDoc(userRef, base, { merge: true });
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) { setAvatarFile(null); setSelectedImageName(""); return; }
    setAvatarFile(file);
    setSelectedImageName(file.name);
  };

  async function uploadAvatarServer(file) {
    if (!file) return { photoURL: null, avatarPath: null };
    const user = auth.currentUser;
    if (!user) throw new Error("Not signed in.");

    const idToken = await user.getIdToken();
    const form = new FormData();
    form.append("file", file);

    const res = await fetch("/api/upload-avatar", {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Upload failed.");
    return { photoURL: data.photoURL, avatarPath: data.avatarPath };
  }

  const handleSignUp = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }

    try {
      setLoading(true);

      await toast.promise(
        (async () => {
          // 1) Create Auth user (keeps them signed in)
          const { user } = await createUserWithEmailAndPassword(auth, email, password);

          // 2) Upload avatar securely via server (if provided)
          let uploaded = { photoURL: null, avatarPath: null };
          if (avatarFile) {
            uploaded = await uploadAvatarServer(avatarFile);
          }

          // 3) Update Firebase profile with displayName + photoURL
          const displayName = `${firstName} ${lastName}`.trim();
          await updateProfile(user, { displayName, photoURL: uploaded.photoURL || undefined });

          // 4) Save/merge Firestore user doc (includes photo fields)
          await upsertUserDoc(user, {
            firstName,
            lastName,
            photoURL: uploaded.photoURL,
            avatarPath: uploaded.avatarPath,
          });

          // 5) Optional: store token
          const token = await user.getIdToken();
          if (typeof window !== "undefined") localStorage.setItem("token", token);

          return "ok";
        })(),
        {
          loading: "Creating your account...",
          success: "Account created! Welcome 👋",
          error: (e) => fbError(e),
        }
      );

      // 6) Redirect without asking to log in again
      if (planFromQuery) {
        // If a plan was preselected before signup → go pay for that plan
        router.replace(`/billing/checkout?plan=${encodeURIComponent(planFromQuery)}`);
      } else {
        // No plan preselected → go to utility
        router.replace("/utility");
      }
    } catch (e) {
      console.error("signup error:", e);
      toast.error(e?.message || "Sign up failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Toaster richColors position="top-right" closeButton />

      <div className="flex w-full flex-col items-center justify-center bg-white pt-5 rounded-2xl max-w-sm w-full text-center gap-4">
        <div className="w-full text-left">
          <label htmlFor="avatar-input" className="block text-sm font-medium text-gray-700 mb-1">
            Profile Image (optional)
          </label>
          <input
            id="avatar-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleFileChange}
            className="block w-full text-sm text-gray-900 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
          />
          {selectedImageName && (
            <p className="mt-1 text-xs text-gray-500">Selected: {selectedImageName}</p>
          )}
        </div>

        <input
          placeholder="First Name"
          className="w-full border border-gray-300 rounded-md px-4 py-2 bg-gray-50 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
          value={firstName}
          onChange={(e)=>setFirstName(e.target.value)}
        />
        <input
          placeholder="Last Name"
          className="w-full border border-gray-300 rounded-md px-4 py-2 bg-gray-50 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
          value={lastName}
          onChange={(e)=>setLastName(e.target.value)}
        />
        <input
          placeholder="Email"
          className="w-full border border-gray-300 rounded-md px-4 py-2 bg-gray-50 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
          value={email}
          onChange={(e)=>setEmail(e.target.value)}
        />
        <input
          type="password"
          placeholder="Password"
          className="w-full border border-gray-300 rounded-md px-4 py-2 bg-gray-50 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
          value={password}
          onChange={(e)=>setPassword(e.target.value)}
        />

        <button
          className={`bg-blue-600 text-white w-full py-2 rounded transition ${loading ? "opacity-60 cursor-not-allowed" : "hover:bg-blue-700"}`}
          onClick={handleSignUp}
          disabled={loading}
        >
          {loading ? "Signing up..." : "Sign Up"}
        </button>

        <div className="w-full">
          <p className="flex text-sm items-center justify-center">
            Already have an account?
            <Link className="text-blue-600 hover:text-blue-700 hover:underline cursor-pointer ml-1" href="/login">
              Sign In
            </Link>
          </p>
        </div>
      </div>
    </>
  );
};

export default CustomSignUp;
