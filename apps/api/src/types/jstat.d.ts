declare module 'jstat' {
  export interface JStatStatic {
    beta: {
      pdf(x: number, alpha: number, beta: number): number;
      cdf(x: number, alpha: number, beta: number): number;
      inv(p: number, alpha: number, beta: number): number;
      mean(alpha: number, beta: number): number;
      median(alpha: number, beta: number): number;
      mode(alpha: number, beta: number): number;
      sample(alpha: number, beta: number): number;
      variance(alpha: number, beta: number): number;
    };
  }

  const jStat: JStatStatic;
  export default jStat;
}
