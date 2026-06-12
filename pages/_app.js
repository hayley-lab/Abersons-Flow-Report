// pages/_app.js
import Head from "next/head";

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        <title>Abersons Flow Report</title>
        <meta name="application-name" content="Abersons Flow Report" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=1" />
        <link rel="shortcut icon" href="/favicon.svg?v=1" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
