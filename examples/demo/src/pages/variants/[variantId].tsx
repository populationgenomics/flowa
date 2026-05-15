import { useRouter } from "next/router";
import { Container, Loader } from "@mantine/core";
import { LiteratureView } from "@/components/literature/LiteratureView";

export default function VariantPage() {
  const router = useRouter();
  const variantId =
    typeof router.query.variantId === "string" ? router.query.variantId : null;

  if (!variantId) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader size="md" />
      </div>
    );
  }

  return (
    <Container size="lg" py="lg">
      <LiteratureView variantId={variantId} />
    </Container>
  );
}
