import 'expo-sqlite/localStorage/install';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  appBaseUrl: string;
}

let client: SupabaseClient | null = null;

export function getSupabaseClient(config: AppConfig): SupabaseClient {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        storage: localStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}
