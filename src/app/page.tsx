"use client";

import { useState } from "react";
import Link from "next/link";
import { Music2, Users, Mic, ShieldCheck, X } from "lucide-react";
import { motion } from "framer-motion";

export default function LandingPage() {
  const [showJoin, setShowJoin] = useState(false);
  const [roomInput, setRoomInput] = useState("");
  const [userName, setUserName] = useState("");

  return (
    <div className="min-h-dvh flex flex-col bg-[#0a0a0a] text-white selection:bg-vs-accent">
      <nav className="fixed top-0 inset-x-0 z-50 glass-panel border-b border-white/5 pt-safe">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 sm:h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-8 h-8 gradient-bg rounded-lg flex items-center justify-center group-active:scale-95 transition-transform">
              <Music2 className="w-5 h-5 text-white" />
            </div>
            <span className="hidden min-[360px]:block font-bold text-lg sm:text-xl tracking-tight gradient-text">VibeSync</span>
          </Link>
          <div className="flex shrink-0 items-center gap-1 sm:gap-4">
            <Link href="/host" className="px-2.5 min-[400px]:px-3.5 sm:px-5 py-2.5 bg-vs-accent hover:bg-vs-accentHover active:bg-vs-accentHover rounded-full text-xs min-[400px]:text-[13px] sm:text-sm font-semibold transition-all shadow-lg shadow-purple-500/20">
              Create Room
            </Link>
            <button
              onClick={() => setShowJoin(true)}
              className="px-2.5 min-[400px]:px-3.5 sm:px-5 py-2.5 border border-white/10 hover:border-white/30 active:border-white/30 rounded-full text-xs min-[400px]:text-[13px] sm:text-sm font-medium transition-all"
            >
              Join Room
            </button>
          </div>
        </div>
      </nav>
      {/* Hero Section */}
      <section className="relative flex-1 flex items-center justify-center pt-20 pb-12 px-4 sm:px-6 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] bg-purple-600/20 rounded-full blur-[120px] animate-pulse-slow"></div>
          <div className="absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] bg-pink-600/20 rounded-full blur-[120px] animate-pulse-slow"></div>
        </div>
        <div className="relative z-10 max-w-5xl mx-auto text-center">
          <motion.div initial={false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8 }} className="mb-6 sm:mb-8">
            <span className="inline-block px-4 py-1.5 bg-vs-accent/10 border border-vs-accent/30 text-vs-accent rounded-full text-xs sm:text-sm font-medium mb-4">🎧 Real-Time Collaborative Listening</span>
          </motion.div>
          <motion.h1 initial={false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.2 }} className="text-[clamp(2rem,10vw,3rem)] sm:text-6xl md:text-8xl font-bold mb-6 sm:mb-8 leading-[1.05] text-balance">Listen together,<br /><span className="gradient-text">wherever you are.</span></motion.h1>
          <motion.p initial={false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.4 }} className="text-base sm:text-lg md:text-xl text-gray-400 mb-8 sm:mb-10 max-w-2xl mx-auto leading-relaxed">One host broadcasts live audio from their browser. Friends join with a link and hear the same stream in real time. Collaboratively build the playlist, vote to skip, and chat — all without installing anything.</motion.p>
          <div className="flex w-full max-w-xl mx-auto flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 sm:gap-4">
            <Link href="/host" className="w-full sm:w-auto min-w-0 px-8 py-4 gradient-bg active:opacity-90 rounded-xl text-sm font-bold flex items-center justify-center gap-2 shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50 transform hover:-translate-y-1 transition-all"><Music2 className="w-5 h-5 shrink-0" /> Create Listening Room</Link>
            <button onClick={() => setShowJoin(true)} className="w-full sm:w-auto min-w-0 px-8 py-4 border border-white/10 hover:border-white/30 active:bg-white/5 rounded-xl text-sm font-medium transition-all">Join Room</button>
          </div>
        </div>
      </section>
      {/* How It Works */}
      <section className="py-12 sm:py-20 px-4 sm:px-6 bg-[#141414] border-t border-white/5">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold mb-8 sm:mb-12 text-center">How it works</h2>
          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4 sm:gap-8">
            {[{icon: <Users className="w-8 h-8 text-vs-accent" />, title: "Create a Room", desc: "Start a listening room and share the invitation link with friends."},{icon: <Mic className="w-8 h-8 text-vs-accent" />, title: "Share Your Audio", desc: "Host shares browser tab audio via WebRTC."},{icon: <ShieldCheck className="w-8 h-8 text-vs-accent" />, title: "Collaborate", desc: "Everyone adds songs, votes to skip, and chats together."}].map((step, idx) => (
              <motion.div key={idx} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.2 }} className="glass-panel p-5 sm:p-8 rounded-2xl">
                <div className="w-12 h-12 bg-vs-accent/20 rounded-lg flex items-center justify-center mb-4 sm:mb-6">{step.icon}</div>
                <h3 className="text-lg sm:text-xl font-semibold mb-2 sm:mb-3">{step.title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{step.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
      {/* Features */}
      <section className="py-12 sm:py-20 pb-24 sm:pb-20 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold mb-8 sm:mb-12 text-center">Built for shared listening</h2>
          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3 sm:gap-6">
            {["Real-time audio streaming via WebRTC","Collaborative playlist management","Skip voting with live results","Group chat with emoji reactions","No installation required","Works on desktop and mobile"].map((feature, idx) => (
              <motion.div key={idx} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.1 }} className="flex items-start gap-3 p-4 sm:p-6 glass-panel rounded-xl">
                <div className="w-6 h-6 rounded-full bg-vs-accent text-white flex items-center justify-center text-xs font-bold shrink-0 mt-1">✓</div>
                <p className="text-sm text-gray-300 leading-relaxed">{feature}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
      {/* Join Modal — bottom sheet on mobile, centered dialog on desktop */}
      {showJoin && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowJoin(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="join-room-title" className="bg-[#141414] border border-white/10 rounded-t-2xl sm:rounded-2xl p-6 sm:p-8 w-full sm:max-w-md max-h-[92dvh] overflow-y-auto overscroll-contain relative pb-safe" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowJoin(false)} aria-label="Close" className="absolute top-4 right-4 p-2 -m-1 text-gray-400 hover:text-white active:text-white transition-colors"><X className="w-5 h-5" /></button>
            <div className="sm:hidden w-10 h-1 bg-white/20 rounded-full mx-auto mb-4"></div>
            <h3 id="join-room-title" className="text-xl font-bold mb-6 text-center sm:text-left">Join a Room</h3>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (roomInput.trim() && userName.trim()) {
                  window.location.href = `/room/${encodeURIComponent(roomInput.trim())}?name=${encodeURIComponent(userName.trim())}`;
                }
              }}
            >
              <div>
                <label htmlFor="join-room-code" className="block text-sm font-medium text-gray-300 mb-2">Room Code</label>
                <input id="join-room-code" name="roomCode" type="text" inputMode="text" autoCapitalize="characters" autoCorrect="off" autoComplete="off" maxLength={8} required value={roomInput} onChange={(e) => setRoomInput(e.target.value.toUpperCase())} placeholder="ABCD1234" className="w-full px-4 py-3 bg-[#0a0a0a] border border-white/10 rounded-xl text-white focus:border-vs-accent focus:ring-1 focus:ring-vs-accent transition-all" />
              </div>
              <div>
                <label htmlFor="join-user-name" className="block text-sm font-medium text-gray-300 mb-2">Your Name</label>
                <input id="join-user-name" name="userName" type="text" autoComplete="nickname" maxLength={32} required value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Enter your nickname" className="w-full px-4 py-3 bg-[#0a0a0a] border border-white/10 rounded-xl text-white focus:border-vs-accent focus:ring-1 focus:ring-vs-accent transition-all" />
              </div>
              <button type="submit" className="w-full py-4 min-h-[52px] gradient-bg active:opacity-90 rounded-xl text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-all" disabled={!roomInput.trim() || !userName.trim()}>Join Listening Room</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}