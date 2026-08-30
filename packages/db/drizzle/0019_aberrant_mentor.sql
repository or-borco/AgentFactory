CREATE TABLE "content_blobs" (
	"sha256" text NOT NULL,
	"org_id" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_blobs_org_id_sha256_pk" PRIMARY KEY("org_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "content_blobs" ADD CONSTRAINT "content_blobs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;