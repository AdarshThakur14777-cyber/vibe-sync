// Supabase client configuration for persistent storage
// This is a placeholder - configure with your Supabase credentials
// See .env.example for required environment variables

export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
export const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// Database schema for persistent storage:
// rooms, participants, playlist_tracks, chat_messages