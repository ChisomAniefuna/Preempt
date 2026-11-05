import DemoPanel from '@/components/DemoPanel';
import { PageTitle } from '@/components/ui';

export default function DemoPage() {
  return (
    <>
      <PageTitle sub="Everything here runs against the PayPal sandbox. No real money moves.">Demo control panel</PageTitle>
      <DemoPanel />
    </>
  );
}
