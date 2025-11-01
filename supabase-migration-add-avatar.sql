-- Migration: Add avatar_url column to profiles table
-- Run this in your Supabase SQL Editor if you've already run supabase-setup.sql

ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS avatar_url TEXT;

