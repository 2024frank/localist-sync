"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/context/AuthContext";

export default function DashboardPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);

  if (loading || !user) return null;

  return (
    <main className="min-h-screen bg-[#0f1117] flex items-center justify-center">
      <div className="text-center">
        <p className="text-zinc-400 text-sm mb-1">Signed in as</p>
        <p className="text-white font-medium mb-6">{user.email}</p>
        <p className="text-zinc-500 text-sm mb-8">Dashboard coming soon.</p>
        <button
          onClick={() => signOut(auth)}
          className="text-zinc-500 hover:text-white text-sm transition"
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
