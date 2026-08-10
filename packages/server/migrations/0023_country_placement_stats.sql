-- Rank countries by where painters connect from, independently of where on
-- the map their pixels land. Cloudflare supplies the ISO country code for
-- trusted proxied requests; unresolvable/direct-development requests simply
-- do not enter this table.

BEGIN;

CREATE TABLE country_placement_stats (
  country_id SMALLINT PRIMARY KEY REFERENCES countries(id),
  placements BIGINT NOT NULL DEFAULT 0
);

COMMIT;
