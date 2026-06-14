ALTER TABLE "instance_settings" ADD COLUMN "guards" jsonb DEFAULT '{}'::jsonb NOT NULL;
