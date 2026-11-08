import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateRoomId(): string {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

export function generateInvitationCode(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function formatTime(seconds: number): string {
  return formatDuration(seconds);
}