# Bank Statement CSV Examples

This file contains synthetic CSV examples from different banks to test the reconciliation tool's parsing capabilities.

## Chase Bank Format

```csv
Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,10/20/2025,"PwP  Privacy.com Privacycom TN: 5199481     WEB ID:  626060084",-99.80,MISC_DEBIT,7139.41,,
CREDIT,10/17/2025,"Online Transfer from CHK ...3515 transaction#: 26622174224",4000.00,ACCT_XFER,7239.21,,
DEBIT,10/15/2025,"Zelle payment to Kiryl Loperev JPM99br1o5z5",-250.00,CHASE_TO_PARTNERFI,3239.21,,
DEBIT,10/14/2025,"CTO Blueprint LL MercuryACH                 PPD ID: 2822557284",-300.00,MISC_DEBIT,3489.21,,
DEBIT,10/14/2025,"Alpenglow Nexus  MercuryACH                 PPD ID: 2822557284",-300.00,MISC_DEBIT,3789.21,,
DEBIT,10/14/2025,"Wise Inc         WISE       TrnWise         WEB ID: 9453233521",-500.85,MISC_DEBIT,4089.21,,
DEBIT,10/14/2025,"Online Transfer to CHK ...3515 transaction#: 26574465790 10/14",-10000.00,ACCT_XFER,4590.06,,
CREDIT,10/10/2025,"Smirnov Labs     MercuryACH                 PPD ID: 2822557284",10000.00,MISC_CREDIT,14590.06,,
DEBIT,10/03/2025,"VENMO            PAYMENT    1045240654825   WEB ID: 3264681992",-200.00,MISC_DEBIT,4590.06,,
DEBIT,10/01/2025,"APPLECARD GSBANK PAYMENT    59926896        WEB ID: 9999999999",-104.07,ACH_DEBIT,4790.06,,
```

## Wells Fargo Format

```csv
Date,Amount,*,*,Description
10/20/2025,-99.80,,,"Privacy.com Payment"
10/17/2025,4000.00,,,"Online Transfer"
10/15/2025,-250.00,,,"Zelle Payment"
10/14/2025,-300.00,,,"CTO Blueprint LLC"
10/14/2025,-300.00,,,"Alpenglow Nexus"
10/14/2025,-500.85,,,"Wise Inc Transfer"
10/14/2025,-10000.00,,,"Account Transfer"
10/10/2025,10000.00,,,"Smirnov Labs Deposit"
10/03/2025,-200.00,,,"Venmo Payment"
10/01/2025,-104.07,,,"Apple Card Payment"
```

## Schwab Format

```csv
Date,Action,Symbol,Description,Amount
10/20/2025,DEPOSIT,,"Privacy.com Payment",-99.80
10/17/2025,TRANSFER,,"Online Transfer",4000.00
10/15/2025,PAYMENT,,"Zelle Payment",-250.00
10/14/2025,PAYMENT,,"CTO Blueprint LLC",-300.00
10/14/2025,PAYMENT,,"Alpenglow Nexus",-300.00
10/14/2025,PAYMENT,,"Wise Inc Transfer",-500.85
10/14/2025,TRANSFER,,"Account Transfer",-10000.00
10/10/2025,DEPOSIT,,"Smirnov Labs Deposit",10000.00
10/03/2025,PAYMENT,,"Venmo Payment",-200.00
10/01/2025,PAYMENT,,"Apple Card Payment",-104.07
```

## Bank of America Format

```csv
Posted Date,Payee,Address,Amount
10/20/2025,Privacy.com,,$99.80
10/17/2025,Online Transfer,,-$4000.00
10/15/2025,Zelle Payment,,$250.00
10/14/2025,CTO Blueprint LLC,,$300.00
10/14/2025,Alpenglow Nexus,,$300.00
10/14/2025,Wise Inc,,$500.85
10/14/2025,Account Transfer,,$10000.00
10/10/2025,Smirnov Labs,,-$10000.00
10/03/2025,Venmo,,$200.00
10/01/2025,Apple Card,,$104.07
```

## Simple Format

```csv
Date,Description,Amount
10/20/2025,Privacy.com Payment,-99.80
10/17/2025,Online Transfer,4000.00
10/15/2025,Zelle Payment,-250.00
10/14/2025,CTO Blueprint LLC,-300.00
10/14/2025,Alpenglow Nexus,-300.00
10/14/2025,Wise Inc Transfer,-500.85
10/14/2025,Account Transfer,-10000.00
10/10/2025,Smirnov Labs Deposit,10000.00
10/03/2025,Venmo Payment,-200.00
10/01/2025,Apple Card Payment,-104.07
```

## Expected Normalization Output

All formats should normalize to:

```json
[
  {
    "date": "2025-10-20",
    "description": "Privacy.com Payment",
    "amount": -99.80,
    "raw_data": "original CSV row"
  },
  {
    "date": "2025-10-17", 
    "description": "Online Transfer",
    "amount": 4000.00,
    "raw_data": "original CSV row"
  }
  // ... etc
]
```

## Common Edge Cases

1. **Negative amounts in parentheses**: `($99.80)` should parse as `-99.80`
2. **Currency symbols**: `$99.80` should parse as `99.80`
3. **Different date formats**: `10/20/2025`, `2025-10-20`, `Oct 20, 2025`
4. **Quoted fields with commas**: `"Company, Inc"` should be parsed as single field
5. **Empty fields**: `,,,` should be handled gracefully
6. **Long descriptions**: Very long merchant names should be preserved
