# -*- coding: utf-8 -*-
"""
Created on Mon Nov 10 12:11:12 2025

@author: 15hal
"""

import numpy as np
from newton_solve import newton_solve   # ← this tells Python where to find it

def F(v):
    x, y = v
    return [
        x**2 + y**2 - 1.0,
        x - y
    ]

def J(v):
    x, y = v
    return [
        [2*x, 2*y],
        [1.0, -1.0]
    ]

x0 = [0.8, 0.6]
sol, info = newton_solve(F, x0, J=J, damping=False)

print("With analytic J ->", sol)
print("Info:", info)
