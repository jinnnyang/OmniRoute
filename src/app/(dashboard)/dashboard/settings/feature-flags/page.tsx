"use client";

import FeatureFlagsGrid from "../components/FeatureFlagsGrid";
import CatalogVisibilityCard from "../components/CatalogVisibilityCard";

export default function FeatureFlagsPage() {
  return (
    <div className="space-y-6">
      <CatalogVisibilityCard />
      <FeatureFlagsGrid />
    </div>
  );
}
