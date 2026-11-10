import React from 'react';

export const LedgerRule: React.FC<{
  double?: boolean;
  variant?: 'single' | 'double';
  className?: string;
}> = ({
  double = false,
  variant,
  className = ''
}) => {
  const isDouble = double || variant === 'double';
  if (isDouble) {
    return <div className={`rule-double w-full my-2 ${className}`} />;
  }
  return <div className={`rule-single w-full my-2 ${className}`} />;
};
