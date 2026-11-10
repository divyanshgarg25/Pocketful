import React from 'react';

export const LedgerRule: React.FC<{ double?: boolean; className?: string }> = ({
  double = false,
  className = ''
}) => {
  if (double) {
    return <div className={`rule-double w-full my-2 ${className}`} />;
  }
  return <div className={`rule-single w-full my-2 ${className}`} />;
};

export const Badge: React.FC<{
  type: 'estimate' | 'seeded' | 'simulated' | 'paypal' | 'moss' | 'ochre' | 'brick' | 'claret';
  children: React.ReactNode;
}> = ({ type, children }) => {
  const styles: Record<string, string> = {
    estimate: 'border-ochre text-ochre bg-parchment',
    seeded: 'border-oat text-taupe bg-sand',
    simulated: 'border-taupe text-taupe bg-sand',
    paypal: 'border-dusty-rose text-claret bg-blush-pink',
    moss: 'border-moss text-moss bg-crisp-white',
    ochre: 'border-ochre text-ochre bg-crisp-white',
    brick: 'border-brick text-brick bg-blush-pink',
    claret: 'border-dusty-rose text-claret bg-blush-pink'
  };

  return (
    <span
      className={`inline-block text-[10px] font-ui uppercase font-semibold tracking-wider px-1.5 py-0.5 border rounded-[2px] ${styles[type] ?? ''}`}
    >
      {children}
    </span>
  );
};
