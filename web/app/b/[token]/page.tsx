import type { Metadata } from 'next';
import BuyerChoice from '@/components/BuyerChoice';

export const metadata: Metadata = { title: 'Your order', robots: { index: false } };

export default async function BuyerPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <BuyerChoice token={token} />;
}
